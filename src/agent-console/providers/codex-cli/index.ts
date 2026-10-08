import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { spawnProcess, resolveSpawn, reportableImage, terminateProcess, closeStdin, protectStdin } from '../../process/index.js';
import { platform } from 'node:process';
import { probeCommand, type ProbeResult } from '../probe.js';
import { TERSE_REPORT_INSTRUCTION, type ProbeContext, type ProviderStatus } from '../types.js';
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
} from '../types.js';
import { NdjsonSplitter } from '../ndjson.js';
import { isSafePathSegment } from '../../store/paths.js';
import { summariseCommand } from './summarise.js';
import { isFileChanges, fileChangesDiff, fileChangeOutput, type FileChange } from './diff.js';

const isWindows = platform === 'win32';
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

// `probeTimeoutMs` is unset in production, which keeps `probeCommand`'s own bound (D141, D226).
// Tests set it: their fake CLI is a node script, and under full-suite load its start alone can
// outlast that bound and be cached as a hung binary (#524).
function probeOk(executable: string, cwd: string, subcommand: string, probeTimeoutMs?: number): Promise<ProbeResult> {
  const resolved = resolveSpawn(executable, [subcommand, '--help'], executable === 'codex');
  return probeCommand(resolved.command, resolved.args, cwd, resolved.shell, probeTimeoutMs);
}

// Cache the in-flight promise, a detected transport, and a timed-out probe: concurrent creates
// share one probe and a hung binary stalls once. A not-found result is dropped once settled, so
// a Codex installed after start is picked up without a restart (D226).
const transportCache = new Map<string, Promise<Transport | null>>();
function detectTransport(executable: string, cwd: string, refresh = false, probeTimeoutMs?: number): Promise<Transport | null> {
  const key = JSON.stringify([executable, cwd]);
  if (refresh) transportCache.delete(key);
  let result = transportCache.get(key);
  if (!result) {
    let hung = false;
    const probing: Promise<Transport | null> = (async () => {
      const appServer = await probeOk(executable, cwd, 'app-server', probeTimeoutMs);
      if (appServer.ok) return 'app-server';
      const exec = await probeOk(executable, cwd, 'exec', probeTimeoutMs);
      if (exec.ok) return 'exec';
      hung = appServer.timedOut || exec.timedOut;
      return null;
    })();
    result = probing;
    transportCache.set(key, probing);
    void probing.then((transport) => {
      if (transport === null && !hung && transportCache.get(key) === probing) transportCache.delete(key);
    });
  }
  return result;
}

function statusForTransport(transport: Transport | null): ProviderStatus {
  return {
    available: transport !== null,
    ...(transport === null ? { unavailableReason: 'agent_unavailable' } : {}),
    capabilities: {
      workspace: 'required', permissions: transport === 'app-server' ? 'interactive' : 'preauthorised', attachments: { supported: false },
      usage: transport === 'app-server', resume: transport !== null,
      streamingDeltas: transport === 'app-server', models: 'free-form',
      sandboxModes: ['read-only', 'workspace-write', 'unrestricted'],
      needsProcess: true, conversationState: 'provider',
    },
  };
}

// A create and its capability snapshot share this exact resolution, even if a
// concurrent refresh replaces the cache while the original probe is still running.
export async function prepareCodex(executable: string, context: ProbeContext, probeTimeoutMs?: number) {
  const transport = await detectTransport(executable, context.cwd, context.refresh, probeTimeoutMs);
  return {
    status: statusForTransport(transport),
    create: (options: AdapterOptions) => buildCodexAdapter(options, executable, transport),
  };
}

export async function probeCodex(executable: string, context: ProbeContext, probeTimeoutMs?: number): Promise<ProviderStatus> {
  return (await prepareCodex(executable, context, probeTimeoutMs)).status;
}

export function resetCodexTransportCacheForTests(): void { transportCache.clear(); }

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
]);

// `item/started`/`item/completed` fire for the operator's own prompt too, echoed back as
// a `userMessage` item — content the operator already has, not new information.
// Other item types outside the mapped handlers carry agent output (an MCP tool call,
// a web search, …) and must fail loudly rather than vanish.
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

// Per-session terse config, sent on thread/start|resume (app-server) or as -c (exec), so the
// operator's global ~/.codex/config.toml is never touched. Reasoning *effort* and the model are
// deliberately absent: terse trims reporting, never depth.
export const TERSE_CODEX_CONFIG: Readonly<Record<string, string | number>> = {
  model_verbosity: 'low',
  model_reasoning_summary: 'none',
  model_auto_compact_token_limit: 120000,
  model_auto_compact_token_limit_scope: 'body_after_prefix',
  tool_output_token_limit: 6000,
};

export async function createCodexAdapter(
  opts: AdapterOptions & { readonly executable?: string; readonly probeTimeoutMs?: number },
): Promise<Result<Adapter, AdapterError>> {
  if (opts.sandbox === null || !SANDBOX_MODES.has(opts.sandbox)) {
    return { ok: false, error: { code: 'unsupported_sandbox', sandbox: String(opts.sandbox) } };
  }
  const executable = opts.executable ?? process.env['SKYNET_CODEX_EXECUTABLE'] ?? 'codex';
  return (await prepareCodex(executable, { cwd: opts.cwd }, opts.probeTimeoutMs)).create(opts);
}

function buildCodexAdapter(opts: AdapterOptions, executable: string, transport: Transport | null): Result<Adapter, AdapterError> {
  if (opts.sandbox === null || !SANDBOX_MODES.has(opts.sandbox)) {
    return { ok: false, error: { code: 'unsupported_sandbox', sandbox: String(opts.sandbox) } };
  }
  const sandbox = opts.sandbox;
  if (transport === null) {
    return { ok: false, error: { code: 'agent_unavailable', image: executable, detail: 'neither `codex app-server` nor `codex exec` responded to --help' } };
  }

  let child: ChildProcess | null = null;
  let killRequested = false;
  let currentModel = opts.model;
  // Each responder closes over one process and its pending RPC ids. Never send an old
  // browser answer to a new child's reused request counter.
  let respondToApproval: Adapter['respond'] | null = null;
  let clearApprovals: (() => void) | null = null;

  function notify(n: AdapterNotification): void {
    opts.notify(n);
  }

  function emitEvent(kind: string, data: unknown, raw: unknown): void {
    notify({ kind: 'event', event: { kind, data, raw } as never });
  }

  // Session notices are buffered by the host until its registry entry exists.
  if (transport === 'exec') {
    queueMicrotask(() => {
      emitEvent('session.notice', { level: 'warn', code: 'usage_unavailable', text: "this session's transport reports no token usage; its burn is unknown, not zero" }, null);
    });
  }

  function terminate(proc: ChildProcess): void {
    terminateProcess(proc, (candidate) => child === candidate);
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
      const filePatches = new Map<string, FileChange[]>();
      const approvals = new Map<RequestId, string | number>();
      const seenApprovalIds = new Set<string | number>();
      const invalidateApprovals = () => { approvals.clear(); };
      clearApprovals = invalidateApprovals;

      function writeMessage(msg: Record<string, unknown>): boolean {
        if (child !== proc || !proc.stdin || proc.stdin.destroyed || proc.stdin.writableEnded || killRequested || resultSeen) return false;
        try {
          proc.stdin.write(JSON.stringify(msg) + '\n');
          return true;
        } catch { return false; }
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
        invalidateApprovals();
        const turnOpen = settled && !resultSeen; // send() already succeeded and no result has ended the turn
        resultSeen = true; // this failure, not a bare process exit, is why the child is about to die
        if (!settled) {
          settled = true;
          resolve({ ok: false, error: { code: 'schema_mismatch', detail } });
        }
        if (child) terminate(child);
        // D220: the close handler stays silent once `resultSeen` is set, so end the open turn here —
        // after the kill, per I59.
        if (turnOpen) emitEvent('turn.ended', { stopReason: 'error', usage: null }, null);
      });

      function handleItemStarted(params: Record<string, unknown>, rec: unknown): void {
        const item = params['item'] as Record<string, unknown> | undefined;
        if (!item) return failSchemaMismatch('item/started carried no item', rec);
        const type = item['type'];
        if (type === 'fileChange') {
          if (typeof item['id'] !== 'string' || !isSafePathSegment(item['id']) || !isFileChanges(item['changes'])) {
            return failSchemaMismatch('fileChange carried an invalid id or changes', rec);
          }
          filePatches.set(item['id'], item['changes']);
          emitEvent('tool.call', {
            callId: item['id'], name: 'apply_patch', input: { changes: item['changes'] },
            summary: item['changes'].map(change => `${change.kind.type}: ${change.path}`).join(', '),
          }, rec);
          return;
        }
        if (type === 'commandExecution') {
          const command = String(item['command'] ?? '');
          emitEvent(
            'tool.call',
            { callId: item['id'], name: 'exec', input: { command }, summary: summariseCommand(command) },
            rec,
          );
          return;
        }
        // Content arrives through deltas and item/completed. Current Codex also
        // announces an empty message item before requesting approval.
        if (type === 'agentMessage' || type === 'reasoning' || IGNORED_ITEM_TYPES.has(String(type))) return;
        failSchemaMismatch(`unrecognised item type on item/started: ${String(type)}`, rec);
      }

      function handleItemCompleted(params: Record<string, unknown>, rec: unknown): void {
        const item = params['item'] as Record<string, unknown> | undefined;
        if (!item) return failSchemaMismatch('item/completed carried no item', rec);
        const type = item['type'];
        if (type === 'fileChange') {
          if (typeof item['id'] !== 'string' || !isSafePathSegment(item['id']) || !isFileChanges(item['changes'])
            || !['completed', 'failed', 'declined'].includes(String(item['status']))) {
            return failSchemaMismatch('fileChange carried an invalid id, changes, or terminal status', rec);
          }
          // The completed item is authoritative; patch notifications are a fallback
          // for a completed item with no changes of its own.
          const changes = item['changes'].length > 0 ? item['changes'] : filePatches.get(item['id']) ?? [];
          filePatches.delete(item['id']);
          const output = fileChangeOutput(changes);
          emitEvent('tool.result', {
            callId: item['id'], ok: item['status'] === 'completed', output,
            truncated: false, bytes: Buffer.byteLength(output, 'utf8'), diff: fileChangesDiff(changes),
          }, rec);
          return;
        }
        if (type === 'reasoning') {
          const summary = (item['summary'] as string[] | undefined) ?? [];
          const content = (item['content'] as string[] | undefined) ?? [];
          const text = (summary.length > 0 ? summary : content).join('\n\n');
          if (text.length > 0 && opts.outputPolicy?.persistReasoning !== false) emitEvent('thinking', { text }, rec);
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
            { callId: item['id'], ok: item['status'] === 'completed', output, truncated: false, bytes: Buffer.byteLength(output, 'utf8'), diff: null },
            rec,
          );
          return;
        }
        if (IGNORED_ITEM_TYPES.has(String(type))) return;
        failSchemaMismatch(`unrecognised item type on item/completed: ${String(type)}`, rec);
      }

      function handleApprovalRequest(msg: Record<string, unknown>, rec: unknown): void {
        const id = msg['id'];
        const params = msg['params'];
        if (!((typeof id === 'number' && Number.isSafeInteger(id)) || (typeof id === 'string' && id.length > 0))
          || !params || typeof params !== 'object' || Array.isArray(params)) {
          return failSchemaMismatch('approval request carried an invalid RPC id or params', rec);
        }
        const input = params as Record<string, unknown>;
        const itemId = input['itemId'];
        if (typeof itemId !== 'string' || !isSafePathSegment(itemId) || seenApprovalIds.has(id)) {
          return failSchemaMismatch('approval request carried an invalid itemId or duplicate RPC id', rec);
        }
        const fileChange = msg['method'] === 'item/fileChange/requestApproval';
        const changes = filePatches.get(itemId);
        if (fileChange ? !changes?.length : typeof input['command'] !== 'string' || !input['command'].length || typeof input['cwd'] !== 'string' || !input['cwd'].length) {
          return failSchemaMismatch('approval request is missing the command/cwd or proposed file changes', rec);
        }
        seenApprovalIds.add(id);
        const requestId = randomUUID() as RequestId;
        approvals.set(requestId, id);
        emitEvent('permission.request', {
          requestId, callId: itemId, tool: fileChange ? 'apply_patch' : 'exec',
          input: fileChange ? { ...input, changes } : input,
          // An exact command alone omits cwd and escalation context. Keep decisions
          // per-call rather than introducing a standing-rule grammar here.
          matchTarget: null, suggestions: [],
        }, rec);
      }

      function handleNotification(method: string, params: Record<string, unknown>, rec: unknown): void {
        switch (method) {
          case 'serverRequest/resolved':
            for (const [requestId, id] of approvals) {
              if (id === params['requestId']) approvals.delete(requestId);
            }
            return;
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
          case 'item/fileChange/patchUpdated':
            if (typeof params['itemId'] !== 'string' || !isSafePathSegment(params['itemId']) || !isFileChanges(params['changes'])) {
              return failSchemaMismatch('patchUpdated carried an invalid itemId or changes', rec);
            }
            filePatches.set(params['itemId'], params['changes']);
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
            invalidateApprovals();
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

      const splitter = new NdjsonSplitter(opts.stdoutLineBytes, () => {
        if (resultSeen) return;
        resultSeen = true;
        invalidateApprovals();
        const detail = 'provider stdout line exceeds the configured cap';
        emitEvent('error', { kind: 'adapter_output_overflow', message: detail, fatal: true }, null);
        if (!settled) { settled = true; resolve({ ok: false, error: { code: 'schema_mismatch', detail } }); }
        else emitEvent('turn.ended', { stopReason: 'error', usage: null }, null);
        if (child) terminate(child);
      });

      function handleLine(line: string): void {
        if (resultSeen || killRequested || child !== proc) return;
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
            if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
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
      const resolved = resolveSpawn(executable, ['app-server'], executable === 'codex');
      try {
        proc = spawnProcess(resolved, { cwd: opts.cwd, overrides: { FORCE_COLOR: '0', NO_COLOR: '1' } });
      } catch (err) {
        resolve({ ok: false, error: { code: 'agent_unavailable', image: executable, detail: (err as Error).message } });
        return;
      }
      child = proc;
      killRequested = false;
      respondToApproval = (requestId, decision, _reason) => {
        const id = approvals.get(requestId);
        if (id === undefined || child !== proc || resultSeen || killRequested) return { ok: false, error: { code: 'no_child' } };
        approvals.delete(requestId);
        // Live-tested accept/decline are one-call decisions. Never select a session
        // grant or an exec-policy amendment. Codex has no deny-reason text field.
        return writeMessage({ id, result: { decision: decision === 'allow' ? 'accept' : 'decline' } })
          ? { ok: true, value: undefined }
          : { ok: false, error: { code: 'write_failed', detail: 'stdin not writable' } };
      };
      // Mirrors `../claude-cli/index.ts`'s identical handler, for the identical reason: a write
      // racing this child's death lands on a pipe whose reader is gone, and an unhandled
      // stream `error` is an uncaught exception that takes the whole server down.
      protectStdin(proc);

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
        invalidateApprovals();
        for (const pending of pendingOutgoing.values()) pending.reject(new Error('process exited'));
        pendingOutgoing.clear();
        // #360: mirrors ../claude-cli/index.ts's identical guard — a close arriving after
        // this child has already been replaced by the next turn's own spawn must not
        // clear that turn's child reference or report an exit that is not its own.
        if (proc !== child) return;
        child = null;
        respondToApproval = null;
        clearApprovals = null;
        notify({ kind: 'exited', code, signal });
        if (!resultSeen) {
          emitEvent('turn.ended', { stopReason: killRequested ? 'interrupted' : 'process_exit', usage: null }, null);
        }
      });

      // The handshake. `initialize` then `thread/start` (fresh) or `thread/resume`
      // (continuing) then `turn/start` — mirrors the per-turn spawn-and-resume shape
      // `../claude-cli/index.ts` uses, adapted to a request/response protocol instead of one
      // stdin line. Not itself part of the contract's mapping table (that only pins the
      // *incoming* notification shapes S8.1 observed); the outgoing request shapes here
      // are this adapter's own, verified against the installed `codex-cli 0.146.0`'s
      // `app-server generate-json-schema` output and a live probe, not against the
      // contract.
      (async () => {
        try {
          await rpcCall('initialize', { clientInfo: { name: 'skynet-hr', version: '0.0.0' } });
          let threadId: string | null = resume;
          const threadOptions = {
            cwd: opts.cwd, sandbox: cliSandboxValue(sandbox), approvalPolicy: 'on-request', model: opts.model,
            ...(opts.outputPolicy?.mode === 'terse'
              ? { config: TERSE_CODEX_CONFIG, developerInstructions: TERSE_REPORT_INSTRUCTION }
              : {}),
          };
          if (resume !== null) {
            try {
              await rpcCall('thread/resume', { threadId: resume, ...threadOptions });
            } catch (err) {
              // Only an explicit vendor refusal means the conversation is gone.
              // Transport failures and timeouts must not silently discard context.
              if ((err as { rpcError?: boolean }).rpcError !== true) throw err;
              emitEvent('session.notice', {
                level: 'warn', code: 'resume_unavailable',
                text: 'The previous conversation could not be resumed. Continuing with a fresh thread; earlier vendor context is unavailable.',
              }, null);
              threadId = null;
            }
          }
          if (threadId === null) {
            const started = (await rpcCall('thread/start', threadOptions)) as
              | { thread?: { id?: string } }
              | undefined;
            const startedId = started?.thread?.id;
            if (typeof startedId !== 'string') throw new Error('thread/start response carried no thread.id');
            threadId = startedId;
          }
          await rpcCall('turn/start', { threadId, input: [{ type: 'text', text }], ...(currentModel === null ? {} : { model: currentModel }) });
          if (!settled) {
            settled = true;
            resolve({ ok: true, value: undefined });
          }
        } catch (err) {
          invalidateApprovals();
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
          if (child === proc) terminate(proc);
        }
      })();
    });
  }

  // -------------------------------------------------------------------------
  // `codex exec --json` — non-interactive NDJSON on stdout (fallback, D107). No deltas,
  // no approval path, and its item ids are a per-turn counter that collides across turns
  // of the same thread (`design/findings/S8-codex-adapter.md` §3). A `command_execution`
  // item maps to a `tool.call`/`tool.result` pair under a composed `CallId`,
  // `<turnId>.<itemId>` (D274, D276, I75): the server's `turnId` is session-unique and
  // persisted, which an adapter-local counter is not.
  // -------------------------------------------------------------------------

  // `null` where the composite would not be a safe path segment (I22, I75).
  function composeCallId(turnId: TurnId, itemId: unknown): CallId | null {
    if (typeof itemId !== 'string') return null;
    const composite = `${turnId}.${itemId}`;
    return isSafePathSegment(composite) ? (composite as CallId) : null;
  }

  function runExec(text: string, resume: CliSessionId | null, turnId: TurnId): Promise<Result<void, AdapterError>> {
    return new Promise((resolve) => {
      let settled = false;
      let resultSeen = false;
      killRequested = false;
      // One `adapter_unknown_record` per dropped item, not one per lifecycle record.
      const droppedItems = new Set<unknown>();

      // Returns the composed `CallId`, or `null` after dropping the item (D276).
      function callIdFor(item: Record<string, unknown>, rec: unknown): CallId | null {
        const callId = composeCallId(turnId, item['id']);
        if (callId !== null) return callId;
        if (!droppedItems.has(item['id'])) {
          droppedItems.add(item['id']);
          emitEvent(
            'error',
            { kind: 'adapter_unknown_record', message: 'a command_execution item whose id would make an unsafe CallId was not mapped', fatal: false },
            rec,
          );
        }
        return null;
      }

      const failSchemaMismatch = makeFailSchemaMismatch(emitEvent, (detail) => {
        const turnOpen = settled && !resultSeen; // send() already succeeded and no result has ended the turn
        resultSeen = true; // this failure, not a bare process exit, is why the child is about to die
        if (!settled) {
          settled = true;
          resolve({ ok: false, error: { code: 'schema_mismatch', detail } });
        }
        if (child) terminate(child);
        // D220: the close handler stays silent once `resultSeen` is set, so end the open turn here —
        // after the kill, per I59.
        if (turnOpen) emitEvent('turn.ended', { stopReason: 'error', usage: null }, null);
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
            if (item['type'] === 'command_execution') {
              const callId = callIdFor(item, rec);
              if (callId === null) return;
              const command = String(item['command'] ?? '');
              emitEvent('tool.call', { callId, name: 'exec', input: { command }, summary: summariseCommand(command) }, rec);
              return;
            }
            if (IGNORED_ITEM_TYPES.has(String(item['type']))) return;
            failSchemaMismatch(`unrecognised item type on item.started: ${String(item['type'])}`, rec);
            return;
          }
          case 'item.completed': {
            const item = rec['item'] as Record<string, unknown> | undefined;
            if (!item) return failSchemaMismatch('item.completed carried no item', rec);
            const itemType = item['type'];
            if (itemType === 'reasoning') {
              const itemText = String(item['text'] ?? '');
              if (itemText.length > 0 && opts.outputPolicy?.persistReasoning !== false) emitEvent('thinking', { text: itemText }, rec);
              return;
            }
            if (itemType === 'agent_message') {
              const itemText = String(item['text'] ?? '');
              if (itemText.length > 0) emitEvent('message', { role: 'assistant', text: itemText }, rec);
              return;
            }
            if (itemType === 'command_execution') {
              const callId = callIdFor(item, rec);
              if (callId === null) return;
              const output = String(item['aggregated_output'] ?? '');
              emitEvent(
                'tool.result',
                // `diff: null` as on `app-server` (D258): no patch item is mapped on this transport.
                { callId, ok: item['status'] === 'completed', output, truncated: false, bytes: Buffer.byteLength(output, 'utf8'), diff: null },
                rec,
              );
              return;
            }
            if (IGNORED_ITEM_TYPES.has(String(itemType))) return;
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

      const splitter = new NdjsonSplitter(opts.stdoutLineBytes, () => {
        if (resultSeen) return;
        resultSeen = true;
        const detail = 'provider stdout line exceeds the configured cap';
        emitEvent('error', { kind: 'adapter_output_overflow', message: detail, fatal: true }, null);
        if (!settled) { settled = true; resolve({ ok: false, error: { code: 'schema_mismatch', detail } }); }
        else emitEvent('turn.ended', { stopReason: 'error', usage: null }, null);
        if (child) terminate(child);
      });
      // `-s` applies on every turn, including a resume — mirrors `runAppServer`'s
      // `thread/start` call, which sets `sandbox` regardless of fresh vs. resumed.
      const args = ['exec', '--json', '--skip-git-repo-check', '-s', cliSandboxValue(sandbox)];
      // The specific thread, not `--last`: `--last` names whichever thread the CLI
      // considers most recent on the whole host, which a concurrent exec-transport
      // session elsewhere on the same host could make the wrong one.
      if (opts.outputPolicy?.mode === 'terse') {
        // Bare values parse as TOML strings/ints, so no shell-hostile quoting is needed.
        for (const [key, value] of Object.entries(TERSE_CODEX_CONFIG)) args.push('-c', `${key}=${value}`);
      }
      if (currentModel !== null) args.push('--model', currentModel);
      if (resume !== null) args.push('resume', resume);

      let proc: ChildProcess;
      const resolved = resolveSpawn(executable, args, executable === 'codex');
      try {
        proc = spawnProcess(resolved, { cwd: opts.cwd, overrides: { FORCE_COLOR: '0', NO_COLOR: '1' } });
      } catch (err) {
        resolve({ ok: false, error: { code: 'agent_unavailable', image: executable, detail: (err as Error).message } });
        return;
      }
      child = proc;
      // As above: an unhandled stream `error` on a pipe whose reader has died is an
      // uncaught exception, and this write is the one most likely to race a kill.
      protectStdin(proc);
      // The prompt goes over stdin (as the real CLI was probed: `echo <prompt> | codex exec
      // --json ...`, `design/findings/S8-codex-adapter.md` §2), never argv — the resolved
      // spawn command runs through a Windows shell for a bare `codex`/`.cmd` executable
      // (`resolveSpawn`), and shell:true joins argv into one unescaped command line,
      // so operator-authored chat text must never be an argument.
      closeStdin(proc, text);

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
        // #360: mirrors ../claude-cli/index.ts's identical guard.
        if (proc !== child) return;
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
    policy: transport === 'app-server' ? { mode: 'interactive', sandbox, banner: null } : { mode: 'preauthorised', sandbox, banner },
    // (D160/S21.8) Undeclared, not merely unprobed: no finding has verified either Codex
    // transport carries a non-text content block, so this stays `false` until one does.
    acceptsAttachments: false,

    send(
      text: string,
      _attachments: readonly AttachmentPayload[],
      resume: CliSessionId | null,
      turnId: TurnId,
      model?: string,
    ): Promise<Result<void, AdapterError>> {
      currentModel = model ?? opts.model;
      return transport === 'app-server' ? runAppServer(text, resume) : runExec(text, resume, turnId);
    },

    respond(requestId: RequestId, decision: PermissionDecision, reason: string | null): Result<void, AdapterError> {
      return respondToApproval?.(requestId, decision, reason) ?? { ok: false, error: { code: 'no_child' } };
    },

    async kill(): Promise<void> {
      const proc = child;
      if (!proc) return;
      killRequested = true;
      clearApprovals?.();
      terminate(proc);
    },
  };

  return { ok: true, value: adapter };
}
