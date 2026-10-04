import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { createCodexAdapter, resetCodexTransportCacheForTests } from './index.js';
import type { AdapterNotification, RequestId } from '../types.js';

const fixture = path.resolve('src/agent-console/providers/codex-cli/fixtures/fake-codex-cli.mjs');
async function waitFor(predicate: () => boolean) {
  const until = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < until, 'timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const requests = (events: AdapterNotification[]) => events.flatMap(n => n.kind === 'event' && n.event.kind === 'permission.request' ? [n.event.data] : []);
const ended = (events: AdapterNotification[]) => events.filter(n => n.kind === 'event' && n.event.kind === 'turn.ended');

async function setup(t: TestContext, scenario: string) {
  const dir = await mkdtemp(path.join(tmpdir(), 'codex-approval-test-'));
  const log = path.join(dir, 'wire.ndjson');
  process.env['SKYNET_CODEX_SCENARIO'] = scenario;
  process.env['SKYNET_CODEX_RPC_LOG'] = log;
  delete process.env['SKYNET_CODEX_NO_APP_SERVER'];
  resetCodexTransportCacheForTests();
  const events: AdapterNotification[] = [];
  const result = await createCodexAdapter({ executable: fixture, cwd: dir as never, model: null, sandbox: 'read-only', streamDeltas: false, notify: n => events.push(n) });
  assert.ok(result.ok);
  t.after(async () => {
    await result.value.kill();
    delete process.env['SKYNET_CODEX_SCENARIO'];
    delete process.env['SKYNET_CODEX_RPC_LOG'];
    await rm(dir, { recursive: true, force: true });
  });
  return { adapter: result.value, events, wire: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}

test('#80 — a server-resolved request cannot be answered later', async t => {
  const { adapter, events, wire } = await setup(t, 'approval-resolved');
  await adapter.send('test', [], null, 'turn-resolved' as never);
  await waitFor(() => events.some(n => n.kind === 'event' && n.event.kind === 'message'));
  assert.equal(requests(events).length, 1);
  assert.equal(adapter.respond(requests(events)[0]!.requestId, 'allow', null).ok, false);
  assert.equal((await wire()).filter(m => m.result).length, 0);
  await adapter.kill();
  await waitFor(() => events.some(n => n.kind === 'exited'));
});

for (const decision of ['allow', 'deny'] as const) {
  for (const scenario of ['approval-request', 'approval-string-id']) {
    test(`#80 — ${scenario}: ${decision} waits for the operator and answers the exact RPC id once`, async t => {
      const { adapter, events, wire } = await setup(t, scenario);
      assert.deepEqual(adapter.policy, { mode: 'interactive', sandbox: 'read-only', banner: null });
      assert.ok((await adapter.send('test', [], null, 'turn-a' as never)).ok);
      await waitFor(() => requests(events).length === 1);
      const request = requests(events)[0]!;
      assert.equal(request.tool, 'exec');
      assert.equal(request.callId, 'item-a1');
      assert.equal(request.input['command'], 'echo approval-probe');
      assert.equal(typeof request.input['cwd'], 'string');
      assert.equal(request.matchTarget, null, 'no command-only standing rule may ignore cwd and escalation context');
      assert.equal(ended(events).length, 0);
      assert.equal((await wire()).filter(m => m.result).length, 0);
      assert.ok(adapter.respond(request.requestId, decision, decision === 'deny' ? 'forced deny' : null).ok);
      await waitFor(() => events.some(n => n.kind === 'exited'));
      const responses = (await wire()).filter(m => m.result);
      assert.equal(responses.length, 1);
      assert.deepEqual(responses[0].result, { decision: decision === 'allow' ? 'accept' : 'decline' });
      assert.equal(responses[0].id, scenario === 'approval-string-id' ? 'rpc-approval' : 0);
      assert.equal(ended(events).length, 1);
      assert.equal(adapter.respond(request.requestId, decision, null).ok, false);
    });
  }
}

test('#80 — a killed turn cannot answer the next process reusing RPC id zero', async t => {
  const { adapter, events, wire } = await setup(t, 'approval-request');
  await adapter.send('one', [], null, 'turn-one' as never);
  await waitFor(() => requests(events).length === 1);
  const old = requests(events)[0]!;
  await adapter.kill();
  assert.equal(adapter.respond(old.requestId, 'allow', null).ok, false);
  await waitFor(() => events.some(n => n.kind === 'exited'));
  await adapter.send('two', [], 'resumed-thread' as never, 'turn-two' as never);
  await waitFor(() => requests(events).length === 2);
  const next = requests(events)[1]!;
  assert.notEqual(old.requestId, next.requestId);
  assert.equal(adapter.respond(old.requestId, 'allow', null).ok, false);
  assert.ok(adapter.respond(next.requestId, 'deny', null).ok);
  assert.equal(adapter.respond(next.requestId, 'allow', null).ok, false);
  await waitFor(() => events.filter(n => n.kind === 'exited').length === 2);
  assert.deepEqual((await wire()).filter(m => m.result).map(m => m.result), [{ decision: 'decline' }]);
});

for (const decision of ['allow', 'deny'] as const) {
  test(`#80 — file edits expose the proposed patch before ${decision}`, async t => {
    const { adapter, events, wire } = await setup(t, 'approval-file');
    await adapter.send('test', [], null, 'turn-file' as never);
    await waitFor(() => requests(events).length === 1);
    const request = requests(events)[0]!;
    assert.equal(request.tool, 'apply_patch');
    assert.deepEqual(request.input['changes'], [{ path: 'accept.txt', kind: { type: 'add' }, diff: 'approval-probe\n' }]);
    assert.equal(request.input['grantRoot'], null);
    assert.equal(ended(events).length, 0);
    assert.ok(adapter.respond(request.requestId, decision, null).ok);
    await waitFor(() => events.some(n => n.kind === 'exited'));
    assert.deepEqual((await wire()).filter(m => m.result).map(m => m.result), [{ decision: decision === 'allow' ? 'accept' : 'decline' }]);
  });
}

for (const scenario of ['approval-bad-id', 'approval-bad-item', 'approval-bad-command', 'approval-bad-cwd', 'approval-duplicate', 'approval-unknown', 'approval-file-missing']) {
  test(`#80 — ${scenario} fails closed without an approval reply`, async t => {
    const { adapter, events, wire } = await setup(t, scenario);
    await adapter.send('test', [], null, 'turn-a' as never);
    await waitFor(() => events.some(n => n.kind === 'exited'));
    assert.equal(requests(events).length, scenario === 'approval-duplicate' ? 1 : 0);
    assert.ok(events.some(n => n.kind === 'event' && n.event.kind === 'error' && n.event.data.kind === 'adapter_schema_mismatch' && n.event.data.fatal));
    assert.equal((await wire()).filter(m => m.result).length, 0);
    assert.equal(adapter.respond(('missing') as RequestId, 'allow', null).ok, false);
  });
}
