import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createClaudeAdapter } from './index.js';
import type { AdapterNotification } from '../../contract/index.js';

const FIXTURE = path.join(process.cwd(), 'src', 'adapters', 'claude', 'fixtures', 'fake-claude-cli.mjs');

function makeAdapter(scenario: string) {
  const notifications: AdapterNotification[] = [];
  const adapter = createClaudeAdapter({
    executable: FIXTURE,
    cwd: process.cwd() as never,
    model: null,
    sandbox: null,
    notify: (n) => notifications.push(n),
  });
  return { adapter, notifications, scenario };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function eventsOf(notifications: readonly AdapterNotification[], kind: string) {
  return notifications
    .filter((n): n is Extract<AdapterNotification, { kind: 'event' }> => n.kind === 'event')
    .filter((n) => n.event.kind === kind);
}

// S1.1 and S1.3 (rows 1–10 of the twelve-row Claude vendor mapping table) and half of
// S1.9 at the adapter layer — the session-manager-level harness round trip is covered
// in `src/session-manager/index.test.ts`.
test('S1.1, S1.3, S1.9 — the twelve-row vendor mapping, and stdin stays writable across a control_request round trip', async () => {
  process.env['SKYNET_TEST_SCENARIO'] = 'full';
  const { adapter, notifications } = makeAdapter('full');

  const sendResult = await adapter.send('hello', null, 'turn-1' as never);
  assert.equal(sendResult.ok, true);

  // Row 1: system/init -> AdapterNotification 'cli-session'.
  await waitUntil(() => notifications.some((n) => n.kind === 'cli-session'));

  // Row 9: control_request/can_use_tool -> permission.request.
  await waitUntil(() => eventsOf(notifications, 'permission.request').length > 0);
  const permissionEvent = eventsOf(notifications, 'permission.request')[0]!;
  const requestId = (permissionEvent.event.data as { requestId: string }).requestId;

  // D109: matchTarget's projection table — Bash projects input.command, verbatim.
  assert.equal((permissionEvent.event.data as { matchTarget: string | null }).matchTarget, 'echo hi');

  // S1.1: stdin is still writable here — this is the point in the real handshake where
  // a naive implementation would already have closed it.
  const respondResult = adapter.respond(requestId as never, 'allow');
  assert.equal(respondResult.ok, true);

  // Row 10: result (success) -> turn.ended, stopReason 'completed'. Reaching this after
  // the control_response is S1.1's assertion in full.
  await waitUntil(() => eventsOf(notifications, 'turn.ended').length > 0);
  const turnEnded = eventsOf(notifications, 'turn.ended')[0]!;
  assert.equal((turnEnded.event.data as { stopReason: string }).stopReason, 'completed');

  // Row 2 and row 3: both compaction subtypes map to session.notice(compaction).
  const notices = eventsOf(notifications, 'session.notice');
  assert.equal(notices.length, 2);
  for (const n of notices) assert.equal((n.event.data as { code: string }).code, 'compaction');

  // Row 4: assistant/text -> message.
  const messages = eventsOf(notifications, 'message');
  assert.ok(messages.some((m) => (m.event.data as { text: string }).text === 'Working on it'));

  // Row 5: assistant/thinking -> thinking.
  const thinking = eventsOf(notifications, 'thinking');
  assert.equal(thinking.length, 1);
  assert.equal((thinking[0]!.event.data as { text: string }).text, 'considering the approach');

  // Row 6: assistant/tool_use -> tool.call.
  const toolCalls = eventsOf(notifications, 'tool.call');
  assert.equal(toolCalls.length, 1);
  assert.equal((toolCalls[0]!.event.data as { name: string }).name, 'Bash');

  // Row 7: assistant/message.usage -> usage, normalised (deduplicated by message id).
  const usageEvents = eventsOf(notifications, 'usage');
  assert.equal(usageEvents.length, 3); // three distinct assistant message ids in the fixture

  // Row 8: user/tool_result -> tool.result (sent by the fixture after control_response).
  await waitUntil(() => eventsOf(notifications, 'tool.result').length > 0);
  assert.equal(eventsOf(notifications, 'tool.result').length, 1);

  // Row 9's pair: permission.resolved is emitted by session-manager in the real system
  // (S4), not the adapter — not asserted here.
});

// Row 11: result, any subtype other than success -> turn.ended, stopReason 'error'.
test('S1.3 — row 11: a non-success result subtype maps to turn.ended/error', async () => {
  process.env['SKYNET_TEST_SCENARIO'] = 'error-result';
  const { adapter, notifications } = makeAdapter('error-result');
  await adapter.send('hello', null, 'turn-2' as never);
  await waitUntil(() => eventsOf(notifications, 'turn.ended').length > 0);
  assert.equal((eventsOf(notifications, 'turn.ended')[0]!.event.data as { stopReason: string }).stopReason, 'error');
});

// Row 12: close with no result seen -> turn.ended, stopReason 'process_exit'.
test('S1.3 — row 12: the child closing with no result seen maps to turn.ended/process_exit', async () => {
  process.env['SKYNET_TEST_SCENARIO'] = 'no-result';
  const { adapter, notifications } = makeAdapter('no-result');
  await adapter.send('hello', null, 'turn-3' as never);
  await waitUntil(() => eventsOf(notifications, 'turn.ended').length > 0);
  assert.equal((eventsOf(notifications, 'turn.ended')[0]!.event.data as { stopReason: string }).stopReason, 'process_exit');
});

// S1.11 — usage, replayed from a real captured CLI run (design/findings/S1-claude-adapter.md),
// is summable: the adapter's emitted usage events sum to the same total as an
// independent dedup-by-message-id computation over the raw fixture.
test('S1.11 — usage events emitted from a real captured run sum to the independently computed total', async () => {
  const fixturePath = path.join(process.cwd(), 'src', 'adapters', 'claude', 'fixtures', 'usage-probe-two-reads.ndjson');
  process.env['SKYNET_TEST_SCENARIO'] = 'usage-real';
  process.env['SKYNET_USAGE_FIXTURE'] = fixturePath;
  const { adapter, notifications } = makeAdapter('usage-real');
  await adapter.send('hello', null, 'turn-usage' as never);
  await waitUntil(() => eventsOf(notifications, 'turn.ended').length > 0);

  const emittedTotal = eventsOf(notifications, 'usage').reduce(
    (sum, e) => sum + (e.event.data as { usage: { outputTokens: number } }).usage.outputTokens,
    0,
  );

  // Independent computation: parse the raw fixture directly, dedup by message id.
  const raw = readFileSync(fixturePath, 'utf8');
  const seen = new Map<string, number>();
  for (const l of raw.split('\n')) {
    if (l.trim().length === 0) continue;
    const rec = JSON.parse(l) as { type: string; message?: { id?: string; usage?: { output_tokens?: number } } };
    if (rec.type !== 'assistant' || !rec.message?.usage) continue;
    const id = rec.message.id!;
    if (!seen.has(id)) seen.set(id, rec.message.usage.output_tokens ?? 0);
  }
  const independentTotal = Array.from(seen.values()).reduce((a, b) => a + b, 0);

  assert.equal(seen.size, 3); // three distinct assistant message ids in this fixture
  assert.equal(emittedTotal, independentTotal);
});

// S1.4 — an unrecognised record kind is non-fatal and the stream continues; a
// malformed JSON line is likewise non-fatal and the stream continues.
test('S1.4 — an unrecognised record kind, and a malformed JSON line, are both non-fatal', async () => {
  process.env['SKYNET_TEST_SCENARIO'] = 'unknown-kind';
  {
    const { adapter, notifications } = makeAdapter('unknown-kind');
    await adapter.send('hello', null, 'turn-4' as never);
    await waitUntil(() => eventsOf(notifications, 'turn.ended').length > 0);
    const errors = eventsOf(notifications, 'error');
    assert.ok(errors.some((e) => (e.event.data as { kind: string }).kind === 'adapter_unknown_record'));
    assert.ok(eventsOf(notifications, 'message').some((m) => (m.event.data as { text: string }).text === 'after the unknown kind'));
  }

  process.env['SKYNET_TEST_SCENARIO'] = 'bad-line';
  {
    const { adapter, notifications } = makeAdapter('bad-line');
    await adapter.send('hello', null, 'turn-5' as never);
    await waitUntil(() => eventsOf(notifications, 'turn.ended').length > 0);
    const errors = eventsOf(notifications, 'error');
    assert.ok(errors.some((e) => (e.event.data as { kind: string }).kind === 'adapter_bad_line'));
    assert.ok(eventsOf(notifications, 'message').some((m) => (m.event.data as { text: string }).text === 'after the bad line'));
  }
});
