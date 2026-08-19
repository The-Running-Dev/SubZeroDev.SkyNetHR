import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { createCodexAdapter } from './index.js';
import { createAdapter } from '../index.js';
import type { AdapterNotification } from '../../contract/index.js';

const FIXTURE = path.join(process.cwd(), 'src', 'adapters', 'codex', 'fixtures', 'fake-codex-cli.mjs');

function makeAdapter(sandbox: 'read-only' | 'workspace-write' | 'unrestricted' = 'workspace-write') {
  const notifications: AdapterNotification[] = [];
  const result = createCodexAdapter({
    executable: FIXTURE,
    cwd: process.cwd() as never,
    model: null,
    sandbox,
    notify: (n) => notifications.push(n),
    streamDeltas: false,
  });
  return { result, notifications };
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

// S8.3 — policy is reported at create, before any turn runs, and names the sandbox.
test('S8.3 — a Codex session reports a preauthorised policy naming its sandbox', () => {
  delete process.env['SKYNET_CODEX_NO_APP_SERVER'];
  const { result } = makeAdapter('read-only');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.vendor, 'codex');
  assert.equal(result.value.policy.mode, 'preauthorised');
  assert.equal(result.value.policy.sandbox, 'read-only');
  assert.ok(result.value.policy.banner !== null && result.value.policy.banner.includes('read-only'));
});

// S21.8/D160 — undeclared, not merely unprobed: no finding has verified either Codex
// transport carries a non-text content block.
test('S21.8/D160 — a Codex session declares acceptsAttachments: false', () => {
  delete process.env['SKYNET_CODEX_NO_APP_SERVER'];
  const { result } = makeAdapter('read-only');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.acceptsAttachments, false);
});

// S8.3/S8.4 — the app-server transport's full mapping: message, thinking, tool.call/
// tool.result, usage from `last`, and zero permission.request events across the turn.
test('S8.3, S8.4 — app-server: the mapped table, and zero permission.request events', async () => {
  delete process.env['SKYNET_CODEX_NO_APP_SERVER'];
  process.env['SKYNET_CODEX_SCENARIO'] = 'full';
  const { result, notifications } = makeAdapter();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const adapter = result.value;

  const sendResult = await adapter.send('hello', [], null, 'turn-1' as never);
  assert.equal(sendResult.ok, true);

  await waitUntil(() => eventsOf(notifications, 'turn.ended').length > 0);

  assert.ok(notifications.some((n) => n.kind === 'cli-session'));
  assert.equal(eventsOf(notifications, 'permission.request').length, 0);

  const thinking = eventsOf(notifications, 'thinking');
  assert.equal(thinking.length, 1);
  assert.equal((thinking[0]!.event.data as { text: string }).text, 'considering the approach');

  const deltas = eventsOf(notifications, 'message.delta');
  assert.equal(deltas.length, 2);

  const messages = eventsOf(notifications, 'message');
  assert.equal(messages.length, 1);
  assert.equal((messages[0]!.event.data as { text: string }).text, 'Working on it');

  const toolCalls = eventsOf(notifications, 'tool.call');
  assert.equal(toolCalls.length, 1);
  assert.equal((toolCalls[0]!.event.data as { callId: string }).callId, 'item-c1');

  const toolResults = eventsOf(notifications, 'tool.result');
  assert.equal(toolResults.length, 1);
  assert.equal((toolResults[0]!.event.data as { ok: boolean; output: string }).ok, true);
  assert.equal((toolResults[0]!.event.data as { ok: boolean; output: string }).output, 'hi\n');

  const usage = eventsOf(notifications, 'usage');
  assert.equal(usage.length, 1);
  assert.equal((usage[0]!.event.data as { usage: { inputTokens: number } }).usage.inputTokens, 10);

  const turnEnded = eventsOf(notifications, 'turn.ended')[0]!;
  assert.equal((turnEnded.event.data as { stopReason: string }).stopReason, 'completed');
});

// S8.5 — an app-server notification outside the mapped table (and outside the harmless
// ignore list) is a schema mismatch: fatal, and the session refuses to start.
test('S8.5 — app-server: an unrecognised notification method is a fatal schema mismatch', async () => {
  process.env['SKYNET_CODEX_SCENARIO'] = 'unknown-method';
  const { result, notifications } = makeAdapter();
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const sendResult = await result.value.send('hello', [], null, 'turn-2' as never);
  assert.equal(sendResult.ok, false);
  if (sendResult.ok) return;
  assert.equal(sendResult.error.code, 'schema_mismatch');

  await waitUntil(() => eventsOf(notifications, 'error').some((e) => (e.event.data as { kind: string }).kind === 'adapter_schema_mismatch'));
  const err = eventsOf(notifications, 'error').find((e) => (e.event.data as { kind: string }).kind === 'adapter_schema_mismatch')!;
  assert.equal((err.event.data as { fatal: boolean }).fatal, true);
});

// S8.5 — the same, for an item `type` outside the three-row table (a real agent action —
// a web search — this contract does not map, not harmless metadata).
test('S8.5 — app-server: an unrecognised item type is a fatal schema mismatch', async () => {
  process.env['SKYNET_CODEX_SCENARIO'] = 'unknown-item-type';
  const { result } = makeAdapter();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const sendResult = await result.value.send('hello', [], null, 'turn-3' as never);
  assert.equal(sendResult.ok, false);
  if (sendResult.ok) return;
  assert.equal(sendResult.error.code, 'schema_mismatch');
});

// S8.4 — the row is marked "unreachable under the shipped policy" because the adapter
// always launches with `approvalPolicy: 'never'`; if the server sends one anyway (a
// defensive case, not exercised by a real session under this policy) it is declined
// directly and the turn still completes with zero permission.request events.
test('S8.4 — an approval request under the shipped policy is declined without a permission.request event', async () => {
  process.env['SKYNET_CODEX_SCENARIO'] = 'approval-request';
  const { result, notifications } = makeAdapter();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const sendResult = await result.value.send('hello', [], null, 'turn-4' as never);
  assert.equal(sendResult.ok, true);

  await waitUntil(() => eventsOf(notifications, 'turn.ended').length > 0);
  assert.equal(eventsOf(notifications, 'permission.request').length, 0);
  const errors = eventsOf(notifications, 'error');
  assert.ok(errors.some((e) => (e.event.data as { kind: string }).kind === 'adapter_unknown_record' && (e.event.data as { fatal: boolean }).fatal === false));
});

// The child dying with no `turn/completed` seen maps to `turn.ended`/`process_exit` —
// mirrors the Claude adapter's equivalent row, not a schema-mismatch case.
test('app-server: the child closing with no turn/completed seen maps to turn.ended/process_exit', async () => {
  process.env['SKYNET_CODEX_SCENARIO'] = 'crash';
  const { result, notifications } = makeAdapter();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  await result.value.send('hello', [], null, 'turn-5' as never);
  await waitUntil(() => eventsOf(notifications, 'turn.ended').length > 0);
  assert.equal((eventsOf(notifications, 'turn.ended')[0]!.event.data as { stopReason: string }).stopReason, 'process_exit');
});

test('app-server: a malformed JSON line is non-fatal and the stream continues', async () => {
  process.env['SKYNET_CODEX_SCENARIO'] = 'bad-line';
  const { result, notifications } = makeAdapter();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  await result.value.send('hello', [], null, 'turn-6' as never);
  await waitUntil(() => eventsOf(notifications, 'turn.ended').length > 0);
  const errors = eventsOf(notifications, 'error');
  assert.ok(errors.some((e) => (e.event.data as { kind: string }).kind === 'adapter_bad_line'));
  assert.ok(eventsOf(notifications, 'message').some((m) => (m.event.data as { text: string }).text === 'after the bad line'));
});

// S8.3/S8.7 — the exec --json fallback: turn lifecycle, messages and thinking still
// stream; tool.call/tool.result are deliberately not synthesised (S8.7 — the item ids on
// this transport collide across turns, and correlation is `20-contract.md § Unresolved`
// 13); no usage event (its basis is undetermined, same section).
test('S8.3, S8.7 — exec fallback: lifecycle and messages map, tool events and usage do not', async () => {
  process.env['SKYNET_CODEX_NO_APP_SERVER'] = '1';
  process.env['SKYNET_CODEX_SCENARIO'] = 'full';
  const { result, notifications } = makeAdapter();
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const sendResult = await result.value.send('hello', [], null, 'turn-7' as never);
  assert.equal(sendResult.ok, true);
  await waitUntil(() => eventsOf(notifications, 'turn.ended').length > 0);

  assert.ok(notifications.some((n) => n.kind === 'cli-session'));
  assert.equal(eventsOf(notifications, 'permission.request').length, 0);
  assert.equal(eventsOf(notifications, 'tool.call').length, 0);
  assert.equal(eventsOf(notifications, 'tool.result').length, 0);
  assert.equal(eventsOf(notifications, 'usage').length, 0);

  const thinking = eventsOf(notifications, 'thinking');
  assert.equal(thinking.length, 1);
  assert.equal((thinking[0]!.event.data as { text: string }).text, 'thinking it over');

  const messages = eventsOf(notifications, 'message');
  assert.equal(messages.length, 1);
  assert.equal((messages[0]!.event.data as { text: string }).text, 'Working on it');

  assert.equal((eventsOf(notifications, 'turn.ended')[0]!.event.data as { stopReason: string }).stopReason, 'completed');
  delete process.env['SKYNET_CODEX_NO_APP_SERVER'];
});

test('S8.5 — exec fallback: an unrecognised record type is a fatal schema mismatch', async () => {
  process.env['SKYNET_CODEX_NO_APP_SERVER'] = '1';
  process.env['SKYNET_CODEX_SCENARIO'] = 'unknown-type';
  const { result } = makeAdapter();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const sendResult = await result.value.send('hello', [], null, 'turn-8' as never);
  assert.equal(sendResult.ok, false);
  if (sendResult.ok) return;
  assert.equal(sendResult.error.code, 'schema_mismatch');
  delete process.env['SKYNET_CODEX_NO_APP_SERVER'];
});

test('createCodexAdapter refuses when neither transport responds', () => {
  const notifications: AdapterNotification[] = [];
  const result = createCodexAdapter({
    executable: path.join(process.cwd(), 'src', 'adapters', 'codex', 'fixtures', 'does-not-exist.mjs'),
    cwd: process.cwd() as never,
    model: null,
    sandbox: 'workspace-write',
    notify: (n) => notifications.push(n),
    streamDeltas: false,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'agent_unavailable');
});

// The dispatcher's own guard (`../index.ts`): Codex has no "no sandbox" option, unlike
// Claude which has no sandbox mechanism at all.
test('createAdapter refuses a Codex session with sandbox: null', () => {
  const result = createAdapter('codex', {
    cwd: process.cwd() as never,
    model: null,
    sandbox: null,
    notify: () => {},
    streamDeltas: false,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'unsupported_sandbox');
});
