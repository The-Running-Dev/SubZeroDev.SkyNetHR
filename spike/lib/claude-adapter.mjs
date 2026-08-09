/**
 * Claude CLI adapter.
 *
 * The only file in the spike that knows the vendor exists. It emits the vendor-neutral
 * events defined in design/20-contract.md, unsequenced — the session manager stamps `seq`
 * (decision D2, so an adapter restart cannot restart the count).
 *
 * Protocol facts here were established by reading Forks-Claude-Code-Chat@ab6e307, which is
 * licensed reference-only. No code was copied. See design/90-decisions.md D8.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createLineSplitter } from './ndjson.mjs';

const IS_WINDOWS = process.platform === 'win32';

export function createClaudeAdapter({ cwd, model, executable = 'claude', emit }) {
  let child = null;
  let cliSessionId = null;
  let turnId = null;
  let announced = false;
  /** requestId -> { callId, input } — the input is kept so the response cannot substitute one */
  const pending = new Map();

  function buildArgs() {
    const args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      // Interactive permissions. This is what makes the console worth building; without
      // it the only options are blanket approval or no tool use.
      '--permission-prompt-tool', 'stdio',
    ];
    if (model) args.push('--model', model);
    // The CLI owns conversation state; we only carry its id forward. Never reconstruct.
    if (cliSessionId) args.push('--resume', cliSessionId);
    return args;
  }

  function writeLine(obj) {
    if (!child?.stdin || child.stdin.destroyed) return false;
    child.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  }

  function handle(rec) {
    switch (rec.type) {
      case 'system':
        if (rec.subtype === 'init') {
          cliSessionId = rec.session_id ?? cliSessionId;
          // We spawn one child per turn and carry state with --resume, so `init` arrives
          // on every turn. `session.started` is a once-per-session fact, so announce only
          // the first — otherwise the client sees the session restart continuously.
          if (!announced) {
            announced = true;
            emit('session.started', {
              vendor: 'claude',
              cwd,
              model: model ?? null,
              policy: { mode: 'interactive' },
            }, rec);
          }
        } else {
          emit('session.notice', { level: 'info', text: rec.subtype ?? 'notice' }, rec);
        }
        return;

      case 'assistant': {
        const usage = rec.message?.usage;
        if (usage) {
          emit('usage', {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheRead: usage.cache_read_input_tokens ?? 0,
            cacheCreate: usage.cache_creation_input_tokens ?? 0,
          }, null);
        }
        for (const c of rec.message?.content ?? []) {
          if (c.type === 'text' && c.text?.trim()) {
            emit('message', { role: 'assistant', text: c.text }, null);
          } else if (c.type === 'thinking' && c.thinking?.trim()) {
            emit('thinking', { text: c.thinking }, null);
          } else if (c.type === 'tool_use') {
            emit('tool.call', {
              callId: c.id,
              name: c.name,
              input: c.input ?? {},
              summary: summarise(c.name, c.input ?? {}),
            }, null);
          }
        }
        return;
      }

      case 'user': {
        for (const c of rec.message?.content ?? []) {
          if (c.type !== 'tool_result') continue;
          const text = typeof c.content === 'string'
            ? c.content
            : (c.content ?? []).map((p) => p.text ?? '').join('');
          emit('tool.result', {
            callId: c.tool_use_id,
            ok: !c.is_error,
            output: text,
            truncated: false,     // S9 does the capping; the spike does not
            bytes: Buffer.byteLength(text, 'utf8'),
          }, null);
        }
        return;
      }

      case 'control_request': {
        if (rec.request?.subtype !== 'can_use_tool') return;
        pending.set(rec.request_id, {
          callId: rec.request.tool_use_id,
          input: rec.request.input ?? {},
        });
        emit('permission.request', {
          requestId: rec.request_id,
          callId: rec.request.tool_use_id,
          tool: rec.request.tool_name,
          // The exact input, never a summary. The operator is the control against a
          // confused or injected agent, and can only be that if they see what runs.
          input: rec.request.input ?? {},
          suggestions: rec.request.permission_suggestions ?? [],
        }, rec);
        return;
      }

      case 'control_response':
        return;   // responses to our own init handshake; nothing to render

      case 'result':
        emit('turn.ended', {
          turnId,
          stopReason: rec.stop_reason ?? rec.subtype ?? 'end_turn',
        }, rec);
        turnId = null;
        // Closing stdin here is what ends the turn cleanly. Doing it any earlier would
        // foreclose the permission handshake entirely.
        if (child?.stdin && !child.stdin.destroyed) child.stdin.end();
        return;

      default:
        // Never drop silently — an unknown record is a contract drift signal (S1.4).
        emit('error', {
          message: `unrecognised record type: ${rec.type}`,
          kind: 'adapter_unknown_record',
          fatal: false,
        }, rec);
    }
  }

  return {
    get cliSessionId() { return cliSessionId; },
    get busy() { return child !== null; },

    /** Start a turn. One child process per turn; the CLI carries state via --resume. */
    send(text) {
      if (child) throw Object.assign(new Error('turn in flight'), { code: 'turn_in_flight' });

      turnId = randomUUID();
      emit('turn.started', { turnId }, null);

      child = spawn(executable, buildArgs(), {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        // On Windows the bare name resolves to a .cmd shim, which needs a shell. With an
        // absolute path we skip the shell, so paths containing spaces are not re-quoted.
        shell: IS_WINDOWS && executable === 'claude',
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      });

      const split = createLineSplitter((err, line) => {
        emit('error', {
          message: `unparseable line: ${err.message}`,
          kind: 'adapter_bad_line',
          fatal: false,
        }, { line });
      });

      child.stdout.on('data', (chunk) => {
        for (const rec of split(chunk)) {
          try { handle(rec); }
          catch (err) {
            emit('error', { message: err.message, kind: 'adapter_crash', fatal: true }, rec);
          }
        }
      });

      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      const finish = (code, signal, expected) => {
        if (!child) return;
        child = null;
        // Anything still waiting is now unanswerable. Resolving it is what stops a client
        // from hanging on a prompt that can never complete (S4.5).
        for (const [requestId] of pending) {
          emit('permission.resolved', {
            requestId, decision: 'deny', scope: 'once',
            operator: 'system', reason: 'cancelled_process_exit',
          }, null);
        }
        pending.clear();
        if (!expected && stderr.trim()) {
          emit('error', { message: stderr.trim(), kind: 'agent_stderr', fatal: true }, null);
        }
        emit('session.exit', { code, signal, expected }, null);
      };

      child.on('close', (code, signal) => finish(code, signal, code === 0));
      child.on('error', (err) => {
        emit('error', {
          message: err.message,
          kind: err.code === 'ENOENT' ? 'agent_unavailable' : 'spawn_failed',
          fatal: true,
        }, null);
        finish(null, null, false);
      });

      writeLine({
        type: 'user',
        session_id: cliSessionId ?? '',
        message: { role: 'user', content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
      });

      emit('message', { role: 'user', text }, null);
      return turnId;
    },

    /** Answer an outstanding permission request. Returns false if it was already resolved. */
    respondPermission({ requestId, decision, scope, operator }) {
      const req = pending.get(requestId);
      if (!req) return false;
      pending.delete(requestId);

      const allow = decision === 'allow';
      const ok = writeLine({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: allow
            ? {
                // The input recorded when the request arrived, never one supplied by the
                // answering client: what runs must be what the operator was shown
                // (20-contract.md I12).
                behavior: 'allow',
                updatedInput: req.input,
                // `updatedPermissions` is never sent. D35 holds standing approvals in this
                // server so every match still produces an event pair and an audit record.
                toolUseID: req.callId,
              }
            : {
                behavior: 'deny',
                message: 'Denied by operator',
                interrupt: true,
                toolUseID: req.callId,
              },
        },
      });
      if (!ok) return false;

      emit('permission.resolved', {
        requestId, decision, scope, operator, reason: 'answered',
      }, null);
      return true;
    },

    interrupt() {
      if (!child) return false;
      // SIGTERM on POSIX; on Windows there are no signals, so kill() terminates.
      child.kill(IS_WINDOWS ? undefined : 'SIGTERM');
      return true;
    },
  };
}

/** One-line, safe-to-show-collapsed rendering. Server-side so clients stay vendor-blind. */
function summarise(name, input) {
  if (name === 'Bash' && input.command) return String(input.command).split('\n')[0].slice(0, 200);
  for (const key of ['file_path', 'path', 'pattern', 'url', 'query']) {
    if (input[key]) return `${name}: ${String(input[key]).slice(0, 200)}`;
  }
  return name;
}
