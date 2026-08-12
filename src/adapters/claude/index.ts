import { spawn, type ChildProcess } from 'node:child_process';
import { platform } from 'node:process';
import type {
  Adapter,
  AdapterError,
  AdapterNotification,
  AdapterOptions,
  CallId,
  CliSessionId,
  PermissionDecision,
  RequestId,
  Result,
  TurnId,
} from '../../contract/index.js';
import { NdjsonSplitter } from '../ndjson.js';
import { BASH_COMMAND_FIELD, summariseToolCall } from './summarise.js';

const isWindows = platform === 'win32';

// SIGTERM-then-SIGKILL grace period for a POSIX process group (D38, `10-design.md §
// Interrupt`). Windows has no equivalent staged termination — `taskkill /T /F` is
// already forceful — so this applies to the POSIX branch of `kill` only.
const KILL_GRACE_MS = 2000;

// Top-level record `type`s the wire protocol may legitimately send that this vocabulary
// does not render. Verified against a real CLI run (`design/findings/S1-claude-adapter.md`):
// `rate_limit_event` and several `system` subtypes (`hook_started`, `hook_response`,
// `thinking_tokens`, `post_turn_summary`, ...) are common, harmless, and no part of the
// twelve-row vendor mapping — flagging them as `adapter_unknown_record` would spam the
// operator with noise on every ordinary turn. Genuinely unrecognised `type`s still do
// (S1.4).
const IGNORED_TOP_LEVEL_TYPES = new Set(['rate_limit_event', 'control_response']);
const IGNORED_SYSTEM_SUBTYPES = new Set([
  'hook_started',
  'hook_response',
  'thinking_tokens',
  'post_turn_summary',
]);

// `PermissionRequest.matchTarget`'s projection table (D109) — the only place tool-shape
// knowledge is permitted to live (I46). Four rows, because four are what
// `design/findings/S1-claude-adapter.md` names; every other tool, including every
// `mcp__*`, projects `null` rather than a guess. Emitted verbatim: no case folding, no
// separator rewriting, no trimming, and a named field that is absent or not a string
// projects `null` rather than a coerced string. `Bash`'s field name is shared with
// `summariseToolCall` (`./summarise.js`) so the two can't silently disagree about it.
function projectMatchTarget(tool: string, input: Readonly<Record<string, unknown>>): string | null {
  const field = tool === 'Bash' ? BASH_COMMAND_FIELD : tool === 'Read' || tool === 'Edit' || tool === 'Write' ? 'file_path' : null;
  if (field === null) return null;
  const value = input[field];
  return typeof value === 'string' ? value : null;
}

export function createClaudeAdapter(opts: AdapterOptions & { readonly executable?: string }): Adapter {
  // The env var is a test seam only: it lets a fixture CLI stand in for the real binary
  // without adding a field to `AdapterOptions`, which the contract fixes.
  const executable = opts.executable ?? process.env['SKYNET_CLAUDE_EXECUTABLE'] ?? 'claude';
  let child: ChildProcess | null = null;
  let cliSessionId: CliSessionId | null = null;
  let currentTurnId: TurnId | null = null;
  let resultSeen = false;
  // Set by `kill`, before the platform kill is issued. Distinguishes an operator-
  // requested termination from a genuine crash so the `close` handler below reports
  // `stopReason: 'interrupted'` rather than `'process_exit'` for the same event (S5.1) —
  // deciding *that* it happened is the manager's, by calling `kill`; naming *what
  // happened* still has to be this close handler, which is the only place that knows
  // whether the process actually stopped on its own.
  let killRequested = false;
  let lastUsageMessageId: string | null = null;
  const pendingByRequestId = new Map<RequestId, { readonly callId: CallId }>();

  function notify(n: AdapterNotification): void {
    opts.notify(n);
  }

  function emitEvent(kind: string, data: unknown, raw: unknown): void {
    notify({ kind: 'event', event: { kind, data, raw } as never });
  }

  function writeLine(obj: Record<string, unknown>): boolean {
    if (!child?.stdin || child.stdin.destroyed) return false;
    child.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  }

  function handleRecord(rec: Record<string, unknown>): void {
    const type = rec['type'];

    if (typeof type !== 'string') {
      emitEvent('error', { kind: 'adapter_unknown_record', message: 'record has no string type', fatal: false }, rec);
      return;
    }

    if (IGNORED_TOP_LEVEL_TYPES.has(type)) return;

    switch (type) {
      case 'system': {
        const subtype = rec['subtype'];
        if (subtype === 'init') {
          const sessionId = rec['session_id'];
          if (typeof sessionId === 'string') {
            cliSessionId = sessionId as CliSessionId;
            notify({ kind: 'cli-session', cliSessionId: cliSessionId });
          }
          return;
        }
        if (subtype === 'compact_boundary' || (subtype === 'status' && rec['status'] === 'compacting')) {
          lastUsageMessageId = null; // a fresh context begins; nothing to deduplicate against
          emitEvent('session.notice', { level: 'info', code: 'compaction', text: 'Compacting context' }, rec);
          return;
        }
        if (typeof subtype === 'string' && IGNORED_SYSTEM_SUBTYPES.has(subtype)) return;
        emitEvent('error', { kind: 'adapter_unknown_record', message: `unrecognised system subtype: ${String(subtype)}`, fatal: false }, rec);
        return;
      }

      case 'assistant': {
        const message = rec['message'] as Record<string, unknown> | undefined;
        const messageId = typeof message?.['id'] === 'string' ? (message['id'] as string) : null;
        const usage = message?.['usage'] as Record<string, unknown> | undefined;
        if (usage && messageId !== null && messageId !== lastUsageMessageId) {
          lastUsageMessageId = messageId;
          emitEvent(
            'usage',
            {
              usage: {
                inputTokens: Number(usage['input_tokens'] ?? 0),
                outputTokens: Number(usage['output_tokens'] ?? 0),
                cacheRead: Number(usage['cache_read_input_tokens'] ?? 0),
                cacheCreate: Number(usage['cache_creation_input_tokens'] ?? 0),
              },
            },
            rec,
          );
        }
        const content = (message?.['content'] as Array<Record<string, unknown>> | undefined) ?? [];
        for (const block of content) {
          if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].length > 0) {
            emitEvent('message', { role: 'assistant', text: block['text'] }, rec);
          } else if (block['type'] === 'thinking' && typeof block['thinking'] === 'string' && block['thinking'].length > 0) {
            emitEvent('thinking', { text: block['thinking'] }, rec);
          } else if (block['type'] === 'tool_use') {
            const name = String(block['name'] ?? '');
            const input = (block['input'] as Record<string, unknown>) ?? {};
            emitEvent(
              'tool.call',
              { callId: block['id'], name, input, summary: summariseToolCall(name, input) },
              rec,
            );
          }
        }
        return;
      }

      case 'user': {
        const message = rec['message'] as Record<string, unknown> | undefined;
        const content = (message?.['content'] as Array<Record<string, unknown>> | undefined) ?? [];
        for (const block of content) {
          if (block['type'] !== 'tool_result') continue;
          const raw = block['content'];
          const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((p) => (p as { text?: string }).text ?? '').join('') : '';
          emitEvent(
            'tool.result',
            {
              callId: block['tool_use_id'],
              ok: !block['is_error'],
              output: text,
              truncated: false, // S9 does the capping; out of scope here
              bytes: Buffer.byteLength(text, 'utf8'),
            },
            rec,
          );
        }
        return;
      }

      case 'control_request': {
        const request = rec['request'] as Record<string, unknown> | undefined;
        if (request?.['subtype'] !== 'can_use_tool') return;
        const requestId = rec['request_id'] as RequestId;
        const callId = request['tool_use_id'] as CallId;
        const tool = request['tool_name'] as string;
        const input = (request['input'] as Record<string, unknown> | undefined) ?? {};
        pendingByRequestId.set(requestId, { callId });
        emitEvent(
          'permission.request',
          {
            requestId,
            callId,
            tool,
            input,
            matchTarget: projectMatchTarget(tool, input),
            suggestions: request['permission_suggestions'] ?? [],
          },
          rec,
        );
        return;
      }

      case 'result': {
        resultSeen = true;
        const subtype = rec['subtype'];
        emitEvent(
          'turn.ended',
          { stopReason: subtype === 'success' ? 'completed' : 'error', usage: null },
          rec,
        );
        if (child?.stdin && !child.stdin.destroyed) child.stdin.end();
        return;
      }

      default:
        emitEvent('error', { kind: 'adapter_unknown_record', message: `unrecognised record type: ${type}`, fatal: false }, rec);
    }
  }

  function buildArgs(resume: CliSessionId | null): string[] {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      '--permission-prompt-tool',
      'stdio',
    ];
    if (opts.model) args.push('--model', opts.model);
    if (resume) args.push('--resume', resume);
    return args;
  }

  const adapter: Adapter = {
    vendor: 'claude',
    policy: { mode: 'interactive', sandbox: null, banner: null },

    send(text: string, resume: CliSessionId | null, turnId: TurnId): Promise<Result<void, AdapterError>> {
      return new Promise((resolve) => {
        currentTurnId = turnId;
        resultSeen = false;
        // Cleared per turn, not per adapter. One adapter serves every turn of a session,
        // so a flag left set by an earlier interrupt would make the *next* turn's genuine
        // crash report `stopReason: 'interrupted'` — an expected end the operator never
        // asked for, hiding a real failure behind a routine one.
        killRequested = false;

        // The resume id lands on an argv that Windows may pass through a shell (below),
        // so a CLI that reported a session id carrying shell metacharacters is refusing
        // to follow its own wire schema — refuse it rather than spawn with it.
        if (resume !== null && !/^[A-Za-z0-9._-]+$/.test(resume)) {
          resolve({ ok: false, error: { code: 'schema_mismatch', detail: `resume session id contains unsafe characters: ${resume}` } });
          return;
        }

        // A `.mjs`/`.js` executable is a test fixture script, not a real vendor binary:
        // Windows cannot exec it directly, so run it under this same Node.
        const isScriptFixture = executable.endsWith('.mjs') || executable.endsWith('.js');
        // A shell is needed on Windows for anything that is not a real executable image:
        // the bare `claude` name (PATH + PATHEXT resolution finds a `.cmd` shim) and any
        // explicit `.cmd`/`.bat` path — modern Node refuses to spawn those without one
        // (EINVAL, thrown synchronously). Quoting guards a shim path with spaces, since
        // a shell spawn concatenates rather than escapes.
        const needsShell = isWindows && !isScriptFixture && (executable === 'claude' || /\.(cmd|bat)$/i.test(executable));
        const spawnCommand = isScriptFixture ? process.execPath : needsShell && /\s/.test(executable) ? `"${executable}"` : executable;
        const spawnArgs = isScriptFixture ? [executable, ...buildArgs(resume)] : buildArgs(resume);

        let proc: ChildProcess;
        try {
          proc = spawn(spawnCommand, spawnArgs, {
            cwd: opts.cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: needsShell,
            // POSIX only (D38, `10-design.md § Platform divergence`): makes this child
            // the leader of a new process group, so its own pid is a real group id and
            // `process.kill(-pid)` in `kill` below reaches everything it later spawns —
            // a compiler, a test runner — not just this one process. Windows has no
            // process-group concept here; `taskkill /T` walks the live process table
            // instead, so `detached` would only detach the console for no benefit.
            detached: !isWindows,
            env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
          });
        } catch (err) {
          // spawn can throw synchronously (EINVAL and friends); a throw here would
          // otherwise reject this promise and bypass the Result contract entirely.
          resolve({ ok: false, error: { code: 'agent_unavailable', image: executable, detail: (err as Error).message } });
          return;
        }
        child = proc;

        let settled = false;
        proc.once('spawn', () => {
          if (settled) return;
          settled = true;
          notify({ kind: 'spawned', pid: proc.pid ?? -1, pgid: isWindows ? null : (proc.pid ?? null), image: executable });
          const wrote = writeLine({
            type: 'user',
            session_id: cliSessionId ?? '',
            message: { role: 'user', content: [{ type: 'text', text }] },
            parent_tool_use_id: null,
          });
          resolve(wrote ? { ok: true, value: undefined } : { ok: false, error: { code: 'write_failed', detail: 'stdin not writable immediately after spawn' } });
        });
        proc.once('error', (err) => {
          const nodeErr = err as NodeJS.ErrnoException;
          if (!settled) {
            settled = true;
            // The child never spawned, so no turn ran: suppress the close handler's
            // `turn.ended` synthesis. `send`'s failed Result is the whole story here,
            // and the manager pairs the already-emitted `turn.started` itself.
            resultSeen = true;
            resolve({
              ok: false,
              error: { code: 'agent_unavailable', image: executable, detail: nodeErr.message },
            });
          }
        });

        const splitter = new NdjsonSplitter();
        proc.stdout!.on('data', (chunk: Buffer) => {
          for (const line of splitter.push(chunk)) {
            let rec: Record<string, unknown>;
            try {
              rec = JSON.parse(line) as Record<string, unknown>;
            } catch (err) {
              emitEvent('error', { kind: 'adapter_bad_line', message: (err as Error).message, fatal: false }, line);
              continue;
            }
            handleRecord(rec);
          }
        });

        proc.on('close', (code, signal) => {
          child = null;
          // D97: the adapter never resolves a permission of its own — resolving every
          // outstanding request as `cancelled_process_exit`, and owing each one an
          // `AuditRecord`, is the manager's, done off the `exited` notification below.
          pendingByRequestId.clear();
          notify({ kind: 'exited', code, signal });
          if (!resultSeen) {
            emitEvent('turn.ended', { stopReason: killRequested ? 'interrupted' : 'process_exit', usage: null }, null);
          }
          currentTurnId = null;
        });
      });
    },

    respond(requestId: RequestId, decision: PermissionDecision): Result<void, AdapterError> {
      if (!child) return { ok: false, error: { code: 'no_child' } };
      const pending = pendingByRequestId.get(requestId);
      if (!pending) return { ok: true, value: undefined }; // already resolved elsewhere; nothing to write
      pendingByRequestId.delete(requestId);
      const allow = decision === 'allow';
      const wrote = writeLine({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: allow
            ? { behavior: 'allow', updatedInput: {}, toolUseID: pending.callId }
            : { behavior: 'deny', message: 'Denied by operator', interrupt: true, toolUseID: pending.callId },
        },
      });
      if (!wrote) return { ok: false, error: { code: 'write_failed', detail: 'stdin not writable' } };
      return { ok: true, value: undefined };
    },

    async kill(): Promise<void> {
      const proc = child;
      if (!proc || proc.pid === undefined) return;
      killRequested = true;
      if (isWindows) {
        // Already terminate-then-force in one step — `/F` — and resolves the tree from
        // the live process table at kill time (D38), so no separate grace period applies
        // here. Failing to kill is non-fatal, but an unlistened ChildProcess 'error'
        // event (taskkill missing, EPERM) throws and takes the whole server down.
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
      // Not awaited: the caller (the manager, on an operator's interrupt) gets its
      // result back as soon as the signal is dispatched. The force follow-up runs on its
      // own timer so a tree that ignores SIGTERM — the case the grace period exists for
      // — is still gone within it, without holding the HTTP response open to find out.
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
    },
  };

  void currentTurnId;
  return adapter;
}
