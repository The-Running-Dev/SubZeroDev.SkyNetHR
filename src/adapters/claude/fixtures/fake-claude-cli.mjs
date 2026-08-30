#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
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
//   unknown-control-request-subtype — a control_request whose subtype is neither
//                   can_use_tool nor on IGNORED_CONTROL_REQUEST_SUBTYPES (#189).
//   unknown-content-block-delta-type — a stream_event/content_block_delta whose delta.type
//                   is neither text_delta nor on IGNORED_CONTENT_BLOCK_DELTA_TYPES (#189).
//   many          — a long run of `assistant` text records with contiguous usage, for
//                   volume assertions.
//   many-big      — SKYNET_MANY_BIG_COUNT (default 50) `assistant` text records, each
//                   SKYNET_MANY_BIG_BYTES (default 20000) bytes, emitted back to back —
//                   megabytes in well under a second, for forcing genuine socket
//                   backpressure on a subscriber that never reads (#133), where `many`'s
//                   volume is too small to reliably cross an OS receive buffer.
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
//   streamed      — twenty assistant text messages in one turn; with
//                   --include-partial-messages on stdin's argv, each is preceded by its
//                   stream_event/content_block_delta chunks (S25.4). One message's text
//                   contains a multi-byte UTF-8 character, split so one delta ends right
//                   before it and the next begins with it. With the flag absent, behaves
//                   exactly like `many` truncated to twenty (S25.6: off changes nothing).
//   malformed-content     — an assistant record whose message.content is an object
//                   instead of an array (#202's reported crash).
//   malformed-tool-id     — an assistant record whose tool_use block carries a numeric id
//                   instead of a string (#202).
//   malformed-control-request — a control_request whose tool_use_id is numeric instead of
//                   a string (#202).
//   malformed-usage — an assistant record whose usage.input_tokens is a string instead of
//                   a number (#202).

const scenario = process.env.SKYNET_TEST_SCENARIO ?? 'full';
// (S25.6) The real CLI only emits stream_event records when this flag is present
// (design/findings/S25-token-streaming-probe.md) — this fixture mirrors that gate rather
// than emitting deltas unconditionally, so a flag-off run proves nothing changed.
const streamDeltasFlag = process.argv.includes('--include-partial-messages');
const sessionId = 'fake-cli-session-' + Math.random().toString(36).slice(2);

function line(obj) {
  // Node's stdio-to-pipe writes are dispatched via overlapped (asynchronous) I/O on
  // Windows even for a few hundred bytes, unlike a POSIX pipe write below PIPE_BUF,
  // which normally completes synchronously at the syscall. A scenario that calls
  // process.exit() right after several of these writes (die-with-pending, no-init,
  // no-result) can tear the process down before Windows has flushed the later ones,
  // silently truncating what the parent adapter reads — S17.3's "1 !== 2" on
  // windows-latest CI (#130) was exactly this: the second control_request lost. A
  // synchronous write blocks until the OS pipe buffer has the bytes, which is a
  // kernel-level guarantee that survives the writer exiting.
  writeSync(1, JSON.stringify(obj) + '\n');
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

// (S25.4) `parts` is the exact split the deltas are sent in — arrival order is what a
// consumer concatenates by (D168), so the caller controls it directly rather than this
// function inventing a chunking of its own.
function streamDeltas(parts, msgId) {
  line({ type: 'stream_event', event: { type: 'message_start', message: { id: msgId, usage: { input_tokens: 1, output_tokens: 1 } } } });
  line({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  for (const part of parts) {
    line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } } });
  }
  line({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  line({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: parts.join('').length } } });
  line({ type: 'stream_event', event: { type: 'message_stop' } });
}

// (S25.4) `parts.join('')` is what `assistantText` then sends as the final `message` —
// deltas and the message they precede always agree, byte for byte, by construction.
function assistantTextStreamed(parts, msgId) {
  if (streamDeltasFlag) streamDeltas(parts, msgId);
  assistantText(parts.join(''), msgId);
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
    // #189/D172 — a control_request subtype outside IGNORED_CONTROL_REQUEST_SUBTYPES
    // (empty today) must surface as adapter_unknown_record, not vanish silently.
    case 'unknown-control-request-subtype':
      line({
        type: 'control_request',
        request_id: 'req-unknown-1',
        request: { subtype: 'totally_unknown_subtype', foo: 'bar' },
      });
      assistantText('after the unknown control_request subtype', 'msg-ucr-1');
      line({ type: 'result', subtype: 'success' });
      return;
    // #189/D172 — a content_block_delta whose delta.type is outside both text_delta and
    // IGNORED_CONTENT_BLOCK_DELTA_TYPES must surface as adapter_unknown_record.
    case 'unknown-content-block-delta-type':
      line({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-ucd-1', usage: { input_tokens: 1, output_tokens: 1 } } } });
      line({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
      line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'totally_unknown_delta_type', foo: 'bar' } } });
      line({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
      line({ type: 'stream_event', event: { type: 'message_stop' } });
      assistantText('after the unknown delta type', 'msg-ucd-2');
      line({ type: 'result', subtype: 'success' });
      return;
    case 'malformed-content':
      line({ type: 'assistant', message: { id: 'msg-malformed-1', content: {} } });
      return;
    case 'malformed-tool-id':
      line({
        type: 'assistant',
        message: {
          id: 'msg-malformed-2',
          content: [{ type: 'tool_use', id: 42, name: 'Bash', input: { command: 'echo hi' } }],
        },
      });
      return;
    case 'malformed-control-request':
      line({
        type: 'assistant',
        message: {
          id: 'msg-malformed-3',
          content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'echo hi' } }],
        },
      });
      line({
        type: 'control_request',
        request_id: 'req-1',
        request: { subtype: 'can_use_tool', tool_use_id: 99, tool_name: 'Bash', input: { command: 'echo hi' }, permission_suggestions: [] },
      });
      return;
    case 'malformed-usage':
      line({
        type: 'assistant',
        message: {
          id: 'msg-malformed-4',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 'five', output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      });
      return;
    case 'many': {
      for (let i = 0; i < 200; i++) assistantText('message ' + i, 'msg-many-' + i);
      line({ type: 'result', subtype: 'success' });
      return;
    }
    case 'many-big': {
      const count = Number(process.env.SKYNET_MANY_BIG_COUNT || 50);
      const size = Number(process.env.SKYNET_MANY_BIG_BYTES || 20000);
      for (let i = 0; i < count; i++) assistantText('x'.repeat(size), 'msg-many-big-' + i);
      line({ type: 'result', subtype: 'success' });
      return;
    }
    case 'streamed': {
      for (let i = 0; i < 20; i++) {
        if (i === 10) {
          // The multi-byte character (a four-byte UTF-8 emoji) starts exactly where the
          // second delta begins — the split S25.4 asks for, at a new granularity than
          // S1.2's whole-record one.
          assistantTextStreamed(['message ten, done ', '🎉 — the tenth message'], 'msg-streamed-10');
        } else {
          assistantTextStreamed(['message ' + i, ', streamed'], 'msg-streamed-' + i);
        }
      }
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
