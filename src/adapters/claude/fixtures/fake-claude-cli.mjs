#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
// A deterministic stand-in for the real `claude` binary, used because
// `--permission-prompt-tool stdio` does not emit `control_request` on the real CLI
// today (design/findings/S1-claude-adapter.md, anthropics/claude-code#34046). This
// script speaks the documented wire protocol exactly, so the adapter's mapping and the
// permission round trip are tested against a real child process and real stdio, just
// not the real vendor binary.
//
// Behaviour is selected by SKYNET_TEST_SCENARIO:
//   full          — one of every one of the twelve mapped record kinds, including a
//                   control_request the caller must answer before `result` is sent.
//   error-result  — a `result` with a non-success subtype.
//   no-result     — exits after some output with no `result` at all.
//   bad-line      — one malformed JSON line, then a valid record.
//   unknown-kind  — one record of a type outside the vocabulary, then a valid record.
//   many          — a long run of `assistant` text records with contiguous usage, for
//                   volume assertions.
//   many-permissions — three sequential control_request/control_response round trips
//                   in one turn, before a final result (S4.3).
//   die-with-pending — emits two control_requests and exits without ever reading a
//                   control_response for either, as if the process crashed mid-turn
//                   with more than one outstanding request (S4.9).
//   no-init       — exits after some output without ever reporting system/init, as if
//                   the process died before the handshake completed (S4.15).
//   grandchild    — spawns a real, ordinary (non-detached) grandchild process that
//                   writes its own pid to SKYNET_GRANDCHILD_MARKER and then idles
//                   forever, and never sends a result — a turn that stays live until
//                   something kills the tree (S5.2).
//   big-tool-result — one tool call whose result is SKYNET_BIG_TOOL_RESULT_BYTES bytes
//                   of untruncated 'x' repeated, for S9's truncation-before-envelope
//                   assertions.
//   mcp-permission — one control_request for an mcp__* tool, outside matchTarget's
//                   projection table, so its matchTarget is always null (S10.6).

const scenario = process.env.SKYNET_TEST_SCENARIO ?? 'full';
const sessionId = 'fake-cli-session-' + Math.random().toString(36).slice(2);

function line(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function toolResultFor(behavior, callId) {
  const allowed = behavior === 'allow';
  line({
    type: 'user',
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: callId,
        content: allowed ? 'ok' : 'Denied by operator',
        is_error: !allowed,
      }],
    },
  });
}

function assistantText(text, msgId) {
  line({
    type: 'assistant',
    message: {
      id: msgId,
      content: [{ type: 'text', text }],
      usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
}

if (scenario !== 'no-init') line({ type: 'system', subtype: 'init', session_id: sessionId });

let buffered = '';
process.stdin.on('data', (chunk) => {
  buffered += chunk.toString('utf8');
  let nl;
  while ((nl = buffered.indexOf('\n')) !== -1) {
    const raw = buffered.slice(0, nl);
    buffered = buffered.slice(nl + 1);
    if (raw.trim().length === 0) continue;
    // S10.3: a test seam only, mirroring SKYNET_CLAUDE_EXECUTABLE — records every line
    // this process's stdin receives so a test can assert on what the manager actually
    // wrote, not just on what it claims to have written.
    if (process.env.SKYNET_STDIN_LOG) appendFileSync(process.env.SKYNET_STDIN_LOG, raw + '\n');
    onLine(JSON.parse(raw));
  }
});

let awaitingControlResponse = false;
let permissionsGranted = 0; // 'many-permissions': how many of its three round trips are done
let currentCallId = 'call-1';

function sendControlRequest(requestId, callId) {
  currentCallId = callId;
  line({
    type: 'assistant',
    message: {
      id: 'msg-req-' + requestId,
      content: [{ type: 'tool_use', id: callId, name: 'Bash', input: { command: 'echo ' + requestId } }],
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
  line({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'can_use_tool', tool_use_id: callId, tool_name: 'Bash', input: { command: 'echo ' + requestId }, permission_suggestions: [] },
  });
  awaitingControlResponse = true;
}

function onLine(msg) {
  if (msg.type === 'control_response') {
    awaitingControlResponse = false;
    const behavior = msg.response?.response?.behavior ?? 'allow';
    if (scenario === 'many-permissions') {
      toolResultFor(behavior, currentCallId);
      permissionsGranted += 1;
      if (permissionsGranted < 3) {
        sendControlRequest('req-' + (permissionsGranted + 1), 'call-' + (permissionsGranted + 1));
        return;
      }
      line({ type: 'result', subtype: 'success' });
      return;
    }
    if (scenario === 'big-tool-result') {
      const size = Number(process.env.SKYNET_BIG_TOOL_RESULT_BYTES || 200000);
      line({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: currentCallId, content: 'x'.repeat(size), is_error: false }] },
      });
      line({ type: 'result', subtype: 'success' });
      return;
    }
    toolResultFor(behavior, currentCallId);
    line({ type: 'result', subtype: 'success' });
    return;
  }
  if (msg.type !== 'user') return;
  runScenario();
}

function runScenario() {
  switch (scenario) {
    case 'full': {
      line({ type: 'system', subtype: 'status', status: 'compacting' });
      line({ type: 'system', subtype: 'compact_boundary' });
      line({ type: 'rate_limit_event', rate_limit_info: {} }); // real-world noise, ignored
      assistantText('Working on it', 'msg-1');
      line({
        type: 'assistant',
        message: {
          id: 'msg-2',
          content: [{ type: 'thinking', thinking: 'considering the approach' }],
          usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      });
      line({
        type: 'assistant',
        message: {
          id: 'msg-3',
          content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'echo hi' } }],
          usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      });
      line({
        type: 'control_request',
        request_id: 'req-1',
        request: { subtype: 'can_use_tool', tool_use_id: 'call-1', tool_name: 'Bash', input: { command: 'echo hi' }, permission_suggestions: [] },
      });
      awaitingControlResponse = true;
      return;
    }
    case 'error-result':
      assistantText('trying', 'msg-e1');
      line({ type: 'result', subtype: 'error_max_turns' });
      return;
    case 'no-result':
      assistantText('about to vanish', 'msg-n1');
      process.exit(0);
      return; // unreachable
    case 'bad-line':
      process.stdout.write('{ this is not json\n');
      assistantText('after the bad line', 'msg-b1');
      line({ type: 'result', subtype: 'success' });
      return;
    case 'unknown-kind':
      line({ type: 'totally_unknown_record_kind', payload: 1 });
      assistantText('after the unknown kind', 'msg-u1');
      line({ type: 'result', subtype: 'success' });
      return;
    case 'many': {
      for (let i = 0; i < 200; i++) assistantText('message ' + i, 'msg-many-' + i);
      line({ type: 'result', subtype: 'success' });
      return;
    }
    case 'many-permissions': {
      sendControlRequest('req-1', 'call-1');
      return;
    }
    case 'big-tool-result': {
      sendControlRequest('req-1', 'call-1');
      return;
    }
    case 'mcp-permission': {
      // A tool outside `matchTarget`'s four-row table (S10.6): every `mcp__*` tool
      // projects `null`, so no standing rule may be created against this request.
      line({
        type: 'assistant',
        message: {
          id: 'msg-mcp-1',
          content: [{ type: 'tool_use', id: 'call-1', name: 'mcp__example__fetch', input: { url: 'https://example.invalid' } }],
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      });
      line({
        type: 'control_request',
        request_id: 'req-1',
        request: { subtype: 'can_use_tool', tool_use_id: 'call-1', tool_name: 'mcp__example__fetch', input: { url: 'https://example.invalid' }, permission_suggestions: [] },
      });
      awaitingControlResponse = true;
      return;
    }
    case 'die-with-pending': {
      for (const [requestId, callId] of [['req-1', 'call-1'], ['req-2', 'call-2']]) {
        line({
          type: 'assistant',
          message: {
            id: 'msg-die-' + requestId,
            content: [{ type: 'tool_use', id: callId, name: 'Bash', input: { command: 'echo ' + requestId } }],
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        });
        line({
          type: 'control_request',
          request_id: requestId,
          request: { subtype: 'can_use_tool', tool_use_id: callId, tool_name: 'Bash', input: { command: 'echo ' + requestId }, permission_suggestions: [] },
        });
      }
      // Exits immediately, never reading a control_response for either — a crash
      // mid-turn with more than one permission request still outstanding (S4.9).
      process.exit(1);
      return; // unreachable
    }
    case 'no-init':
      assistantText('vanished before the handshake completed', 'msg-noinit-1');
      process.exit(1);
      return; // unreachable
    case 'grandchild': {
      // Ordinary (not `detached`) spawn, so it inherits this process's process group on
      // POSIX and is this process's child in the Windows process table — either way,
      // exactly the descendant a tree kill (D38) must reach and a pid-only kill must not.
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync(process.env.SKYNET_GRANDCHILD_MARKER, JSON.stringify({ cliPid: process.pid, grandchildPid: grandchild.pid }));
      // No result: the turn stays live until something kills the tree.
      return;
    }
    case 'usage-real': {
      // Replays a real, captured CLI run verbatim (S1.11) — everything after this
      // script's own synthetic `system/init` line.
      const fixturePath = process.env.SKYNET_USAGE_FIXTURE;
      const raw = readFileSync(fixturePath, 'utf8');
      for (const l of raw.split('\n')) {
        if (l.trim().length === 0) continue;
        const rec = JSON.parse(l);
        if (rec.type === 'system' && rec.subtype === 'init') continue; // already sent our own
        process.stdout.write(l + '\n');
      }
      return;
    }
    default:
      line({ type: 'result', subtype: 'success' });
  }
}

process.stdin.on('end', () => {
  if (!awaitingControlResponse) process.exit(0);
});
