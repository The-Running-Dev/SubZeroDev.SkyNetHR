import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { platform } from 'node:process';
import type {
  Adapter,
  AdapterError,
  AdapterNotification,
  AdapterOptions,
  AttachmentPayload,
  CallId,
  CliSessionId,
  PermissionDecision,
  RequestId,
  Result,
  SandboxMode,
  TurnId,
} from '../../contract/index.js';
import { NdjsonSplitter } from '../ndjson.js';
import { summariseCommand } from './summarise.js';

const isWindows = platform === 'win32';
const KILL_GRACE_MS = 2000; // mirrors the Claude adapter's SIGTERM-then-SIGKILL grace (D38)
// `detectTransport` below runs up to two of these, synchronously, in the middle of session
// creation (D107 — transport selection happens once, at create). A `--help` on a responsive
// binary returns near-instantly; this bounds how long a slow-to-respond one can block the
// whole server's single thread — and therefore every other operator's session — per probe.
const PROBE_TIMEOUT_MS = 2000;

type Transport = 'app-server' | 'exec';

// `SandboxMode` is this contract's vendor-neutral vocabulary; the CLI's own flag values
// differ only for the third one (`--sandbox danger-full-access`, confirmed against the
// installed `codex-cli 0.146.0`'s `--help` and JSON-RPC schema).
function cliSandboxValue(mode: SandboxMode): string {
  switch (mode) {
    case 'read-only':
      return 'read-only';
    case 'workspace-write':
      return 'workspace-write';
    case 'unrestricted':
      return 'danger-full-access';
  }
}

function sandboxBanner(mode: SandboxMode): string {
  return `Codex is preauthorised, running under the '${mode}' sandbox`;
}

const SANDBOX_MODES = new Set<SandboxMode>(['read-only', 'workspace-write', 'unrestricted']);

interface ResolvedSpawn {
  readonly command: string;
  readonly args: string[];
  readonly shell: boolean;
}

// Shared by the transport probe (spawnSync, below) and the real per-turn spawn: a
// `.mjs`/`.js` executable is a test fixture, run under this same Node; the bare `codex`
// name or an explicit `.cmd`/`.bat` needs a shell on Windows for PATH/PATHEXT resolution
// (Node refuses to spawn those directly). Mirrors `../claude/index.ts`'s identical need.
function resolveSpawn(executable: string, extraArgs: string[]): ResolvedSpawn {
  const isScriptFixture = executable.endsWith('.mjs') || executable.endsWith('.js');
  const needsShell = isWindows && !isScriptFixture && (executable === 'codex' || /\.(cmd|bat)$/i.test(executable));
  const command = isScriptFixture ? process.execPath : needsShell && /\s/.test(executable) ? `"${executable}"` : executable;
  const args = isScriptFixture ? [executable, ...extraArgs] : extraArgs;
  return { command, args, shell: needsShell };
}

// (#201) With `shell: true` on Windows, Node launches `%ComSpec%` and the reported
// `proc.pid` names *that* shell process, not the resolved executable — `tasklist` for
// that pid reports the shell's own image (`cmd.exe` by default), never `executable`.
// Recording anything else here is what makes the boot reaper's exact-image comparison
// (`session-manager/index.ts`'s `imagesMatch`) reject the real process tree as a
// mismatch after a crash. Mirrors `../claude/index.ts`'s identical need.
function reportableImage(executable: string, usedShell: boolean): string {
  if (!usedShell) return executable;
  const comspec = process.env['ComSpec'] ?? process.env['COMSPEC'] ?? 'cmd.exe';
  return comspec.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
}

function probeOk(executable: string, cwd: string, subcommand: string): boolean {
  const resolved = resolveSpawn(executable, [subcommand, '--help']);
  const result = spawnSync(resolved.command, resolved.args, { cwd, shell: resolved.shell, timeout: PROBE_TIMEOUT_MS });
  return result.error === undefined && result.status === 0;
}

// `createAdapter` is synchronous (20-contract.md § adapters/*), so transport selection
// happens here, once, via a short-lived `--help` probe rather than during the first
// `send()` — matching D107's "once, at create". Whichever subcommand fails or is absent
// falls through to the next; if neither responds, the caller reports `agent_unavailable`
// exactly as it would for a missing binary, because from here the two cases are
// indistinguishable and D107 says they should be treated the same.
function detectTransportUncached(executable: string, cwd: string): Transport | null {
  if (probeOk(executable, cwd, 'app-server')) return 'app-server';
  if (probeOk(executable, cwd, 'exec')) return 'exec';
  return null;
}

// (#134) A real deployment names one executable for its whole life, so a result probed
// once is valid for every session after it — re-probing inside every `manager.create`
// (up to two 2-second `spawnSync` calls) stalled the single-threaded server for every
// other operator waiting on an unrelated session. Keyed on `(executable, cwd)`, the same
// two inputs `detectTransportUncached` already takes, so this changes nothing about what
// is detected — only how many times.
const transportCache = new Map<string, Transport | null>();

function detectTransport(executable: string, cwd: string): Transport | null {
  const key = JSON.stringify([executable, cwd]);
  if (transportCache.has(key)) return transportCache.get(key)!;
  const detected = detectTransportUncached(executable, cwd);
  transportCache.set(key, detected);
  return detected;
}

// Test seam only: a real deployment never needs this, because its executable's transport
// never changes mid-process — but a test that toggles the fixture's own behaviour (e.g.
// `SKYNET_CODEX_NO_APP_SERVER`) against the *same* executable path needs a fresh probe per
// case, not the first case's cached answer.
export function resetCodexTransportCacheForTests(): void {
  transportCache.clear();
}

// Notification methods observed on a real `codex app-server 0.146.0` session
// (a plain "say hello" turn) that carry no content the operator needs and are not in
// `20-contract.md § Vendor mapping — Codex`'s eight-row table: startup housekeeping,
// account/rate-limit bookkeeping, and thread/turn status echoes. Held here exactly as
// D92 holds Claude's ignore list — "adding to it is an adapter change, never a change to
// `ErrorEventKind`" (20-contract.md). A method outside both this set and the mapped table
// is a genuine schema mismatch, not silently dropped.
const IGNORED_APP_SERVER_METHODS = new Set([
  'thread/status/changed',
  'thread/archived',
  'thread/deleted',
  'thread/unarchived',
  'thread/closed',
  'skills/changed',
  'thread/name/updated',
  'thread/goal/updated',
  'thread/goal/cleared',
  'thread/environment/connected',
  'thread/environment/disconnected',
  'thread/settings/updated',
  'hook/started',
  'hook/completed',
  'turn/diff/updated',
  'turn/plan/updated',
  'item/autoApprovalReview/started',
  'item/autoApprovalReview/completed',
  'item/plan/delta',
  'command/exec/outputDelta',
  'process/outputDelta',
  'process/exited',
  'item/commandExecution/terminalInteraction',
  'serverRequest/resolved',
  'item/mcpToolCall/progress',
  'mcpServer/oauthLogin/completed',
  'mcpServer/startupStatus/updated',
  'account/updated',
  'account/rateLimits/updated',
  'app/list/updated',
  'remoteControl/status/changed',
  'externalAgentConfig/import/progress',
  'externalAgentConfig/import/completed',
  'fs/changed',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'thread/compacted',
  'model/rerouted',
  'model/verification',
  'turn/moderationMetadata',
  'model/safetyBuffering/updated',
  'warning',
  'guardianWarning',
  'deprecationNotice',
  'configWarning',
  'fuzzyFileSearch/sessionUpdated',
  'fuzzyFileSearch/sessionCompleted',
  'thread/realtime/started',
  'thread/realtime/itemAdded',
  'thread/realtime/transcript/delta',
  'thread/realtime/transcript/done',
  'thread/realtime/outputAudio/delta',
  'thread/realtime/sdp',
  'thread/realtime/error',
  'thread/realtime/closed',
  'windows/worldWritableWarning',
  'windowsSandbox/setupCompleted',
  'account/login/completed',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
]);

// `item/started`/`item/completed` fire for the operator's own prompt too, echoed back as
// a `userMessage` item — content the operator already has, not new information. Every
// other item `type` outside the contract's three (`reasoning`, `agentMessage`,
// `commandExecution`) is real agent output this table does not describe (a file edit, an
// MCP tool call, a web search, …) and must fail loudly rather than vanish.
const IGNORED_ITEM_TYPES = new Set(['userMessage']);

// Shared by both transports' `failSchemaMismatch`: emits the fatal error event, then hands
// off to `onFail` to settle the transport's own `send()` promise and terminate its child.
// `onFail` must mark the turn as seen — a schema mismatch is a resolution the `close`
// handler already knows about, not a bare process exit — so the two don't independently
// disagree about whether a `turn.ended` still needs synthesising once the child actually exits.
function makeFailSchemaMismatch(
  emitEvent: (kind: string, data: unknown, raw: unknown) => void,
  onFail: (detail: string) => void,
): (detail: string, rec: unknown) => void {
  return (detail, rec) => {
    emitEvent('error', { kind: 'adapter_schema_mismatch', message: detail, fatal: true }, rec);
    onFail(detail);
  };
}

export function createCodexAdapter(
  opts: AdapterOptions & { readonly executable?: string },
): Result<Adapter, AdapterError> {
  const executable = opts.executable ?? process.env['SKYNET_CODEX_EXECUTABLE'] ?? 'codex';
  // The dispatcher (../index.ts) refuses `sandbox: null`, but does not validate a non-null
  // value against the enum — a caller that reaches this function directly (a test, or a
  // future caller) must still fail closed on a malformed value rather than let it fall
  // through `cliSandboxValue`'s switch as `undefined`.
  if (opts.sandbox === null || !SANDBOX_MODES.has(opts.sandbox)) {
    return { ok: false, error: { code: 'unsupported_sandbox', sandbox: String(opts.sandbox) } };
  }
  const sandbox = opts.sandbox;
  const transport = detectTransport(executable, opts.cwd);
  if (transport === null) {
    return { ok: false, error: { code: 'agent_unavailable', image: executable, detail: 'neither `codex app-server` nor `codex exec` responded to --help' } };
  }

  let child: ChildProcess | null = null;
  let killRequested = false;

  function notify(n: AdapterNotification): void {
    opts.notify(n);
  }

  function emitEvent(kind: string, data: unknown, raw: unknown): void {
    notify({ kind: 'event', event: { kind, data, raw } as never });
  }

  // D146/D149: the `exec --json` fallback reports no `usage` events at all (its basis is
  // undetermined, `20-contract.md § Vendor mapping — Codex § Usage`), so `PayrollView.burn`
  // would otherwise sum to zero indistinguishable from an idle session. Queued rather than
  // called inline: `createCodexAdapter` returns synchronously, before the manager has
  // registered this session's entry against `opts.notify`'s closure (`session-manager`'s
  // `create` sets it right after this call returns), so a synchronous `notify` here would
  // be dropped. Queuing lets that registration finish first — it is still session-manager's
  // very next synchronous step, well ahead of any `turn.started`, which cannot fire before
  // an operator's first `message()` call.
  if (transport === 'exec') {
    queueMicrotask(() => {
      emitEvent('session.notice', { level: 'warn', code: 'usage_unavailable', text: "this session's transport reports no token usage; its burn is unknown, not zero" }, null);
    });
  }

  function terminate(proc: ChildProcess): void {
    if (proc.pid === undefined) return;
    if (isWindows) {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F']).once('error', () => {});
      return;
    }
    const pid = proc.pid;
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        proc.kill('SIGTERM');
      } catch {
        // Already gone.
      }
    }
    setTimeout(() => {
      if (child !== proc) return; // already exited; 'close' cleared it
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }, KILL_GRACE_MS).unref();
  }

  // -------------------------------------------------------------------------
  // `codex app-server` — JSON-RPC 2.0 over stdio (primary, D107).
  // -------------------------------------------------------------------------

  function runAppServer(text: string, resume: CliSessionId | null): Promise<Result<void, AdapterError>> {
    return new Promise((resolve) => {
      let settled = false;
      let resultSeen = false;
      let requestSeq = 1;
      const pendingOutgoing = new Map<number, { resolve: (result: unknown) => void; reject: (err: Error) => void }>();

      function writeMessage(msg: Record<string, unknown>): boolean {
        if (!child?.stdin || child.stdin.destroyed) return false;
        child.stdin.write(JSON.stringify(msg) + '\n');
        return true;
      }

      function rpcCall(method: string, params: Record<string, unknown>, timeoutMs = 15000): Promise<unknown> {
        return new Promise((res, rej) => {
          const id = requestSeq++;
          const timer = setTimeout(() => {
            pendingOutgoing.delete(id);
            rej(new Error(`${method} timed out waiting for a response`));
          }, timeoutMs);
          pendingOutgoing.set(id, {
            resolve: (result) => {
              clearTimeout(timer);
              res(result);
            },
            reject: (err) => {
              clearTimeout(timer);
              rej(err);
            },
          });
          const wrote = writeMessage({ id, method, params });
          if (!wrote) {
            clearTimeout(timer);
            pendingOutgoing.delete(id);
            rej(new Error('stdin not writable'));
          }
        });
      }

      const failSchemaMismatch = makeFailSchemaMismatch(emitEvent, (detail) => {
        resultSeen = true; // this failure, not a bare process exit, is why the child is about to die
        if (!settled) {
          settled = true;
          resolve({ ok: false, error: { code: 'schema_mismatch', detail } });
        }
        if (child) terminate(child);
      });

      function handleItemStarted(params: Record<string, unknown>, rec: unknown): void {
        const item = params['item'] as Record<string, unknown> | undefined;
        if (!item) return failSchemaMismatch('item/started carried no item', rec);
        const type = item['type'];
        if (type === 'commandExecution') {
          const command = String(item['command'] ?? '');
          emitEvent(
            'tool.call',
            { callId: item['id'], name: 'exec', input: { command }, summary: summariseCommand(command) },
            rec,
          );
          return;
        }
        if (type === 'reasoning' || IGNORED_ITEM_TYPES.has(String(type))) return;
        failSchemaMismatch(`unrecognised item type on item/started: ${String(type)}`, rec);
      }

      function handleItemCompleted(params: Record<string, unknown>, rec: unknown): void {
        const item = params['item'] as Record<string, unknown> | undefined;
        if (!item) return failSchemaMismatch('item/completed carried no item', rec);
        const type = item['type'];
        if (type === 'reasoning') {
          const summary = (item['summary'] as string[] | undefined) ?? [];
          const content = (item['content'] as string[] | undefined) ?? [];
          const text = (summary.length > 0 ? summary : content).join('\n\n');
          if (text.length > 0) emitEvent('thinking', { text }, rec);
          return;
        }
        if (type === 'agentMessage') {
          const text = String(item['text'] ?? '');
          if (text.length > 0) emitEvent('message', { role: 'assistant', text }, rec);
          return;
        }
        if (type === 'commandExecution') {
          const output = String(item['aggregatedOutput'] ?? '');
          emitEvent(
            'tool.result',
            { callId: item['id'], ok: item['status'] === 'completed', output, truncated: false, bytes: Buffer.byteLength(output, 'utf8') },
            rec,
          );
          return;
        }
        if (IGNORED_ITEM_TYPES.has(String(type))) return;
        failSchemaMismatch(`unrecognised item type on item/completed: ${String(type)}`, rec);
      }

      function handleApprovalRequest(msg: Record<string, unknown>, rec: unknown): void {
        // Unreachable under the shipped policy (`20-contract.md § Vendor mapping —
        // Codex`, "Policy, and the approval prompt now known to be reachable") — the
        // adapter always launches with `approvalPolicy: 'never'`. If one arrives anyway
        // it is answered directly, here, rather than routed through the manager's
        // `permission.request` path: I25 says a Codex session emits zero of those, and
        // there is no operator-facing route to answer a request the shipped policy
        // guarantees never to send.
        writeMessage({ id: msg['id'], result: { decision: 'decline' } });
        emitEvent(
          'error',
          { kind: 'adapter_unknown_record', message: 'an approval request arrived under the preauthorised policy and was declined', fatal: false },
          rec,
        );
      }

      function handleNotification(method: string, params: Record<string, unknown>, rec: unknown): void {
        switch (method) {
          case 'thread/started': {
            const threadId = (params['thread'] as Record<string, unknown> | undefined)?.['id'];
            if (typeof threadId === 'string') notify({ kind: 'cli-session', cliSessionId: threadId as CliSessionId });
            return;
          }
          case 'turn/started':
            return;
          case 'item/started':
            handleItemStarted(params, rec);
            return;
          case 'item/reasoning/summaryTextDelta':
          case 'item/commandExecution/outputDelta':
            return;
          case 'item/agentMessage/delta': {
            const delta = params['delta'];
            if (typeof delta === 'string' && delta.length > 0) emitEvent('message.delta', { role: 'assistant', text: delta }, rec);
            return;
          }
          case 'item/completed':
            handleItemCompleted(params, rec);
            return;
          case 'thread/tokenUsage/updated': {
            const last = (params['tokenUsage'] as Record<string, unknown> | undefined)?.['last'] as Record<string, unknown> | undefined;
            if (last) {
              emitEvent(
                'usage',
                {
                  usage: {
                    inputTokens: Number(last['inputTokens'] ?? 0),
                    outputTokens: Number(last['outputTokens'] ?? 0),
                    cacheRead: Number(last['cachedInputTokens'] ?? 0),
                    cacheCreate: Number(last['cacheWriteInputTokens'] ?? 0),
                  },
                },
                rec,
              );
            }
            return;
          }
          case 'turn/completed': {
            resultSeen = true;
            const turn = params['turn'] as Record<string, unknown> | undefined;
            const status = turn?.['status'];
            const stopReason = status === 'completed' ? 'completed' : status === 'interrupted' ? 'interrupted' : status === 'failed' ? 'error' : null;
            if (stopReason === null) {
              failSchemaMismatch(`turn/completed reported an unexpected status: ${String(status)}`, rec);
              return;
            }
            emitEvent('turn.ended', { stopReason, usage: null }, rec);
            if (child) terminate(child);
            return;
          }
          default:
            if (IGNORED_APP_SERVER_METHODS.has(method)) return;
            failSchemaMismatch(`unrecognised app-server notification: ${method}`, rec);
        }
      }

      const splitter = new NdjsonSplitter();

      function handleLine(line: string): void {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch (err) {
          emitEvent('error', { kind: 'adapter_bad_line', message: (err as Error).message, fatal: false }, line);
          return;
        }
        const method = msg['method'];
        if (typeof method === 'string') {
          if ('id' in msg) {
            // A request from the server, not a notification. Only one is in the
            // mapped table.
            if (method === 'item/commandExecution/requestApproval') {
              handleApprovalRequest(msg, msg);
            } else {
              failSchemaMismatch(`unrecognised app-server request: ${method}`, msg);
            }
            return;
          }
          handleNotification(method, (msg['params'] as Record<string, unknown>) ?? {}, msg);
          return;
        }
        // A response to one of our own outgoing calls (initialize / thread.start /
        // thread.resume / turn.start), matched by id. Not itself a "record" in the
        // contract's mapping-table sense, so an unmatched one is not a schema mismatch —
        // it is simply not tracked (already timed out, or the id was never ours).
        const id = msg['id'];
        if (typeof id === 'number') {
          const pending = pendingOutgoing.get(id);
          if (!pending) return;
          pendingOutgoing.delete(id);
          if ('error' in msg) {
            pending.reject(Object.assign(new Error(`rpc error: ${JSON.stringify(msg['error'])}`), { rpcError: true }));
          } else {
            pending.resolve(msg['result']);
          }
        }
      }

      let proc: ChildProcess;
      const resolved = resolveSpawn(executable, ['app-server']);
      try {
        proc = spawn(resolved.command, resolved.args, {
          cwd: opts.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: resolved.shell,
          detached: !isWindows,
          env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        });
      } catch (err) {
        resolve({ ok: false, error: { code: 'agent_unavailable', image: executable, detail: (err as Error).message } });
        return;
      }
      child = proc;
      killRequested = false;
      // Mirrors `../claude/index.ts`'s identical handler, for the identical reason: a write
      // racing this child's death lands on a pipe whose reader is gone, and an unhandled
      // stream `error` is an uncaught exception that takes the whole server down.
      proc.stdin?.on('error', () => {});

      proc.once('spawn', () => {
        notify({
          kind: 'spawned',
          pid: proc.pid ?? -1,
          pgid: isWindows ? null : (proc.pid ?? null),
          image: reportableImage(executable, resolved.shell),
        });
      });
      proc.once('error', (err) => {
        if (!settled) {
          settled = true;
          resultSeen = true; // no turn ran; suppress the close handler's synthesis below
          resolve({ ok: false, error: { code: 'agent_unavailable', image: executable, detail: (err as NodeJS.ErrnoException).message } });
        }
      });

      proc.stdout!.on('data', (chunk: Buffer) => {
        for (const line of splitter.push(chunk)) handleLine(line);
      });

      proc.on('close', (code, signal) => {
        child = null;
        notify({ kind: 'exited', code, signal });
        if (!resultSeen) {
          emitEvent('turn.ended', { stopReason: killRequested ? 'interrupted' : 'process_exit', usage: null }, null);
        }
        for (const pending of pendingOutgoing.values()) pending.reject(new Error('process exited'));
        pendingOutgoing.clear();
      });

      // The handshake. `initialize` then `thread/start` (fresh) or `thread/resume`
      // (continuing) then `turn/start` — mirrors the per-turn spawn-and-resume shape
      // `../claude/index.ts` uses, adapted to a request/response protocol instead of one
      // stdin line. Not itself part of the contract's mapping table (that only pins the
      // *incoming* notification shapes S8.1 observed); the outgoing request shapes here
      // are this adapter's own, verified against the installed `codex-cli 0.146.0`'s
      // `app-server generate-json-schema` output and a live probe, not against the
      // contract.
      (async () => {
        try {
          await rpcCall('initialize', { clientInfo: { name: 'skynet-hr', version: '0.0.0' } });
          let threadId: string;
          if (resume !== null) {
            threadId = resume;
            await rpcCall('thread/resume', { threadId: resume });
          } else {
            const started = (await rpcCall('thread/start', { cwd: opts.cwd, sandbox: cliSandboxValue(sandbox), approvalPolicy: 'never' })) as
              | { thread?: { id?: string } }
              | undefined;
            const startedId = started?.thread?.id;
            if (typeof startedId !== 'string') throw new Error('thread/start response carried no thread.id');
            threadId = startedId;
          }
          await rpcCall('turn/start', { threadId, input: [{ type: 'text', text }] });
          if (!settled) {
            settled = true;
            resolve({ ok: true, value: undefined });
          }
        } catch (err) {
          if (!settled) {
            settled = true;
            const rpcError = (err as { rpcError?: boolean }).rpcError === true;
            resolve({
              ok: false,
              error: rpcError
                ? { code: 'schema_mismatch', detail: (err as Error).message }
                : { code: 'agent_unavailable', image: executable, detail: (err as Error).message },
            });
          }
          if (child) terminate(child);
        }
      })();
    });
  }

  // -------------------------------------------------------------------------
  // `codex exec --json` — non-interactive NDJSON on stdout (fallback, D107). No deltas,
  // no approval path, and per S8.7 its item ids are a per-turn counter that collides
  // across turns of the same thread (`design/findings/S8-codex-adapter.md` §3) — tool
  // correlation on this transport is `20-contract.md § Unresolved` 13 and this slice may
  // not invent it (S8.7). Turn lifecycle, messages and thinking still stream; a
  // `command_execution` item is a recognised record that this adapter deliberately does
  // not turn into a `tool.call`/`tool.result` pair.
  // -------------------------------------------------------------------------

  function runExec(text: string, resume: CliSessionId | null): Promise<Result<void, AdapterError>> {
    return new Promise((resolve) => {
      let settled = false;
      let resultSeen = false;
      killRequested = false;

      const failSchemaMismatch = makeFailSchemaMismatch(emitEvent, (detail) => {
        resultSeen = true; // this failure, not a bare process exit, is why the child is about to die
        if (!settled) {
          settled = true;
          resolve({ ok: false, error: { code: 'schema_mismatch', detail } });
        }
        if (child) terminate(child);
      });

      function handleLine(line: string): void {
        let rec: Record<string, unknown>;
        try {
          rec = JSON.parse(line) as Record<string, unknown>;
        } catch (err) {
          emitEvent('error', { kind: 'adapter_bad_line', message: (err as Error).message, fatal: false }, line);
          return;
        }
        const type = rec['type'];
        switch (type) {
          case 'thread.started': {
            const threadId = rec['thread_id'];
            if (typeof threadId === 'string') notify({ kind: 'cli-session', cliSessionId: threadId as CliSessionId });
            // The first legitimate record on this transport: resolving here, rather
            // than on 'spawn', is what lets a schema mismatch that is genuinely the
            // very first thing the CLI says (S8.5) win the race and return
            // `schema_mismatch` instead of a `send()` that already reported success.
            if (!settled) {
              settled = true;
              resolve({ ok: true, value: undefined });
            }
            return;
          }
          case 'turn.started':
            return;
          case 'item.started': {
            const item = rec['item'] as Record<string, unknown> | undefined;
            if (!item) return failSchemaMismatch('item.started carried no item', rec);
            if (item['type'] === 'command_execution' || IGNORED_ITEM_TYPES.has(String(item['type']))) return; // S8.7: correlation not implemented on this transport
            failSchemaMismatch(`unrecognised item type on item.started: ${String(item['type'])}`, rec);
            return;
          }
          case 'item.completed': {
            const item = rec['item'] as Record<string, unknown> | undefined;
            if (!item) return failSchemaMismatch('item.completed carried no item', rec);
            const itemType = item['type'];
            if (itemType === 'reasoning') {
              const itemText = String(item['text'] ?? '');
              if (itemText.length > 0) emitEvent('thinking', { text: itemText }, rec);
              return;
            }
            if (itemType === 'agent_message') {
              const itemText = String(item['text'] ?? '');
              if (itemText.length > 0) emitEvent('message', { role: 'assistant', text: itemText }, rec);
              return;
            }
            if (itemType === 'command_execution' || IGNORED_ITEM_TYPES.has(String(itemType))) return; // S8.7
            failSchemaMismatch(`unrecognised item type on item.completed: ${String(itemType)}`, rec);
            return;
          }
          case 'turn.completed':
            resultSeen = true;
            // `usage` is deliberately not read here: its basis (cumulative vs marginal)
            // is undetermined (`20-contract.md § Usage`, `## Unresolved` 12), and I28
            // forbids guessing.
            emitEvent('turn.ended', { stopReason: 'completed', usage: null }, rec);
            if (child) terminate(child);
            return;
          default:
            failSchemaMismatch(`unrecognised exec record type: ${String(type)}`, rec);
        }
      }

      const splitter = new NdjsonSplitter();
      // `-s` applies on every turn, including a resume — mirrors `runAppServer`'s
      // `thread/start` call, which sets `sandbox` regardless of fresh vs. resumed.
      const args = ['exec', '--json', '--skip-git-repo-check', '-s', cliSandboxValue(sandbox)];
      // The specific thread, not `--last`: `--last` names whichever thread the CLI
      // considers most recent on the whole host, which a concurrent exec-transport
      // session elsewhere on the same host could make the wrong one.
      if (resume !== null) args.push('resume', resume);

      let proc: ChildProcess;
      const resolved = resolveSpawn(executable, args);
      try {
        proc = spawn(resolved.command, resolved.args, {
          cwd: opts.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: resolved.shell,
          detached: !isWindows,
          env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        });
      } catch (err) {
        resolve({ ok: false, error: { code: 'agent_unavailable', image: executable, detail: (err as Error).message } });
        return;
      }
      child = proc;
      // As above: an unhandled stream `error` on a pipe whose reader has died is an
      // uncaught exception, and this write is the one most likely to race a kill.
      proc.stdin?.on('error', () => {});
      // The prompt goes over stdin (as the real CLI was probed: `echo <prompt> | codex exec
      // --json ...`, `design/findings/S8-codex-adapter.md` §2), never argv — the resolved
      // spawn command runs through a Windows shell for a bare `codex`/`.cmd` executable
      // (`resolveSpawn`, above), and shell:true joins argv into one unescaped command line,
      // so operator-authored chat text must never be an argument.
      proc.stdin?.end(text);

      proc.once('spawn', () => {
        notify({
          kind: 'spawned',
          pid: proc.pid ?? -1,
          pgid: isWindows ? null : (proc.pid ?? null),
          image: reportableImage(executable, resolved.shell),
        });
      });
      proc.once('error', (err) => {
        resultSeen = true;
        if (!settled) {
          settled = true;
          resolve({ ok: false, error: { code: 'agent_unavailable', image: executable, detail: (err as NodeJS.ErrnoException).message } });
        }
      });

      proc.stdout!.on('data', (chunk: Buffer) => {
        for (const line of splitter.push(chunk)) handleLine(line);
      });

      proc.on('close', (code, signal) => {
        child = null;
        notify({ kind: 'exited', code, signal });
        if (!resultSeen) {
          emitEvent('turn.ended', { stopReason: killRequested ? 'interrupted' : 'process_exit', usage: null }, null);
        }
        // The child exited before ever producing a `thread.started` and before any
        // schema mismatch fired: no send() resolution has happened yet (a crash before
        // any output at all), which would otherwise hang the caller forever.
        if (!settled) {
          settled = true;
          resolve({ ok: false, error: { code: 'agent_unavailable', image: executable, detail: 'the process exited before reporting thread.started' } });
        }
      });
    });
  }

  const banner = sandboxBanner(sandbox);

  const adapter: Adapter = {
    vendor: 'codex',
    policy: { mode: 'preauthorised', sandbox, banner },
    // (D160/S21.8) Undeclared, not merely unprobed: no finding has verified either Codex
    // transport carries a non-text content block, so this stays `false` until one does.
    acceptsAttachments: false,

    send(
      text: string,
      _attachments: readonly AttachmentPayload[],
      resume: CliSessionId | null,
      _turnId: TurnId,
    ): Promise<Result<void, AdapterError>> {
      return transport === 'app-server' ? runAppServer(text, resume) : runExec(text, resume);
    },

    // I25: the shipped policy is `preauthorised`, so the manager's `pending` map — the
    // only source of a real `requestId` — is always empty for a Codex session. Nothing
    // is ever outstanding to respond to.
    respond(_requestId: RequestId, _decision: PermissionDecision): Result<void, AdapterError> {
      if (!child) return { ok: false, error: { code: 'no_child' } };
      return { ok: true, value: undefined };
    },

    async kill(): Promise<void> {
      const proc = child;
      if (!proc) return;
      killRequested = true;
      terminate(proc);
    },
  };

  return { ok: true, value: adapter };
}
