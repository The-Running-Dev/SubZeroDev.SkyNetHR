#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
// A deterministic stand-in for the real `codex` binary. Speaks both transports this
// adapter drives — `app-server`'s JSON-RPC 2.0 over stdio, and `exec --json`'s
// NDJSON-on-stdout one-shot — with shapes verified against the installed
// `codex-cli 0.146.0` (`app-server generate-json-schema`, and a live probe of both
// subcommands), not guessed. `--help` on either subcommand is what
// `detectTransport` (`../index.ts`) probes at adapter creation; SKYNET_CODEX_NO_APP_SERVER
// makes the app-server probe fail so a test can force fallback selection.
//
// Behaviour is selected by SKYNET_CODEX_SCENARIO. See each `case` below for what each
// name drives; both transports share the same scenario names where the shape overlaps.

const args = process.argv.slice(2);
const subcommand = args[0];
const scenario = process.env.SKYNET_CODEX_SCENARIO ?? 'full';

if (args[1] === '--help') {
  // (#134) A caching regression can only be told apart from a correct re-probe-every-time
  // by counting how many times this actually ran — an external, append-only log rather
  // than an in-process counter, since each probe is its own child process with no memory
  // of the last one.
  if (process.env.SKYNET_CODEX_PROBE_LOG) appendFileSync(process.env.SKYNET_CODEX_PROBE_LOG, subcommand + '\n');
  if (subcommand === 'app-server' && process.env.SKYNET_CODEX_NO_APP_SERVER === '1') process.exit(1);
  process.exit(0);
}

function line(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// ---------------------------------------------------------------------------
// app-server: JSON-RPC 2.0 over stdio
// ---------------------------------------------------------------------------

if (subcommand === 'app-server') {
  const threadId = 'fake-thread-' + Math.random().toString(36).slice(2);
  const turnId = 'fake-turn-' + Math.random().toString(36).slice(2);
  let buffered = '';

  function respond(id, result) {
    line({ id, result });
  }

  function notify(method, params) {
    line({ method, params });
  }

  function runTurnScenario() {
    switch (scenario) {
      case 'full': {
        notify('thread/status/changed', { threadId, status: { type: 'active' } }); // ignored, harmless
        notify('item/started', { item: { id: 'item-user', type: 'userMessage', content: [] }, threadId, turnId }); // echo, ignored
        notify('item/completed', { item: { id: 'item-user', type: 'userMessage', content: [] }, threadId, turnId });
        notify('item/started', { item: { id: 'item-r1', type: 'reasoning', summary: [], content: [] }, threadId, turnId });
        notify('item/completed', { item: { id: 'item-r1', type: 'reasoning', summary: ['considering the approach'], content: [] }, threadId, turnId });
        notify('item/started', { item: { id: 'item-c1', type: 'commandExecution', command: 'echo hi', status: 'inProgress' }, threadId, turnId });
        notify('item/agentMessage/delta', { threadId, turnId, itemId: 'item-m1', delta: 'Work' });
        notify('item/agentMessage/delta', { threadId, turnId, itemId: 'item-m1', delta: 'ing on it' });
        notify('item/completed', { item: { id: 'item-c1', type: 'commandExecution', command: 'echo hi', aggregatedOutput: 'hi\n', exitCode: 0, status: 'completed' }, threadId, turnId });
        notify('item/completed', { item: { id: 'item-m1', type: 'agentMessage', text: 'Working on it' }, threadId, turnId });
        notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: { inputTokens: 10, outputTokens: 7, cachedInputTokens: 0, cacheWriteInputTokens: 0, totalTokens: 17, reasoningOutputTokens: 0 }, last: { inputTokens: 10, outputTokens: 7, cachedInputTokens: 0, cacheWriteInputTokens: 0, totalTokens: 17, reasoningOutputTokens: 0 } } });
        notify('turn/completed', { threadId, turn: { id: turnId, items: [], itemsView: 'summary', status: 'completed', error: null, startedAt: null, completedAt: null, durationMs: null } });
        return;
      }
      case 'unknown-method': {
        notify('totally/unknown/method', { threadId });
        return;
      }
      case 'unknown-item-type': {
        notify('item/completed', { item: { id: 'item-x', type: 'webSearch', query: 'q' }, threadId, turnId });
        return;
      }
      case 'approval-request': {
        // A real client id counter starts at 1 for `initialize`; the fixture's own
        // outgoing request ids are namespaced well above that so they cannot collide.
        line({ id: 9001, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'item-a1', command: 'rm -rf /', approvalId: null } });
        return;
      }
      case 'crash': {
        notify('item/completed', { item: { id: 'item-m1', type: 'agentMessage', text: 'about to vanish' }, threadId, turnId });
        process.exit(1);
        return; // unreachable
      }
      case 'bad-line': {
        process.stdout.write('{ not json\n');
        notify('item/completed', { item: { id: 'item-m1', type: 'agentMessage', text: 'after the bad line' }, threadId, turnId });
        notify('turn/completed', { threadId, turn: { id: turnId, items: [], itemsView: 'summary', status: 'completed', error: null, startedAt: null, completedAt: null, durationMs: null } });
        return;
      }
      default:
        notify('turn/completed', { threadId, turn: { id: turnId, items: [], itemsView: 'summary', status: 'completed', error: null, startedAt: null, completedAt: null, durationMs: null } });
    }
  }

  process.stdin.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    let nl;
    while ((nl = buffered.indexOf('\n')) !== -1) {
      const raw = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      if (raw.trim().length === 0) continue;
      onLine(JSON.parse(raw));
    }
  });

  function onLine(msg) {
    if (msg.method === 'initialize') {
      respond(msg.id, { userAgent: 'fake-codex-cli/0.0.0' });
      return;
    }
    if (msg.method === 'thread/start') {
      respond(msg.id, { thread: { id: threadId } });
      notify('thread/started', { thread: { id: threadId } });
      return;
    }
    if (msg.method === 'thread/resume') {
      respond(msg.id, { thread: { id: threadId } });
      return;
    }
    if (msg.method === 'turn/start') {
      // The two schema-mismatch scenarios emit their bad record before ever
      // acknowledging turn/start, so a client that resolves `send()` as soon as the
      // handshake acks is still guaranteed to see the bad record first — this is what
      // "the very first thing the CLI says is wrong" means, not a race against it.
      if (scenario === 'unknown-method' || scenario === 'unknown-item-type') {
        runTurnScenario();
        return;
      }
      respond(msg.id, { turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: null, completedAt: null, durationMs: null } });
      notify('turn/started', { threadId, turn: { id: turnId } });
      runTurnScenario();
      return;
    }
    // A response to `item/commandExecution/requestApproval` (the fixture's own outgoing
    // request, above): finish the turn once the adapter has answered it.
    if (msg.id === 9001) {
      notify('item/completed', { item: { id: 'item-a1', type: 'commandExecution', command: 'rm -rf /', aggregatedOutput: '', exitCode: null, status: 'declined' }, threadId, turnId });
      notify('turn/completed', { threadId, turn: { id: turnId, items: [], itemsView: 'summary', status: 'completed', error: null, startedAt: null, completedAt: null, durationMs: null } });
    }
  }
} else if (subcommand === 'exec') {
  // ---------------------------------------------------------------------------
  // exec --json: one-shot NDJSON on stdout, prompt as the trailing positional arg.
  // ---------------------------------------------------------------------------
  const threadId = 'fake-exec-thread-' + Math.random().toString(36).slice(2);

  switch (scenario) {
    case 'full': {
      line({ type: 'thread.started', thread_id: threadId });
      line({ type: 'turn.started' });
      line({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'thinking it over' } });
      line({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'echo hi', aggregated_output: '', exit_code: null, status: 'in_progress' } });
      line({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'echo hi', aggregated_output: 'hi\n', exit_code: 0, status: 'completed' } });
      line({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Working on it' } });
      line({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0 } });
      break;
    }
    case 'unknown-type': {
      // Emitted before `thread.started` — the adapter resolves `send()` on that record
      // specifically (`../index.ts`, runExec), so a mismatch that is genuinely the very
      // first thing on the wire must precede it to be observed deterministically rather
      // than racing it.
      line({ type: 'totally.unknown.record' });
      break;
    }
    case 'crash': {
      line({ type: 'thread.started', thread_id: threadId });
      line({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'about to vanish' } });
      process.exit(1);
      break; // unreachable
    }
    default:
      line({ type: 'thread.started', thread_id: threadId });
      line({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } });
  }
} else {
  process.exit(1);
}
