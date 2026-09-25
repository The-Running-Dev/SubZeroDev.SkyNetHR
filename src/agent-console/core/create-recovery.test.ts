import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSessionCore } from './index.js';
import { createFsSessionStore } from '../store/fs.js';
import type { CreateAttemptState, HostCreateCallbacks } from './create-attempts.js';
import type { Checkpoints, RuntimeOptions, SessionCore, SessionId, SessionStore } from './types.js';

const ok = <T>(value: T) => ({ ok: true as const, value });
const success = () => ok(undefined);
async function fixture(t: TestContext, wrapStore: (store: SessionStore) => SessionStore = s => s) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'create-recovery-')));
  const config: RuntimeOptions = { storageRoot: root as never, workspaceRoots: [root as never], includeRaw: false, streamDeltas: false,
    caps: { ringCapacity: 20, toolResultBytes: 1024, subscriberQueueHighWater: 20, auditPageMax: 10, standingRuleBytes: 1024, attachmentBytes: 1024, attachmentCount: 2, sessionToolOutputBytes: 4096 } };
  let uncertain: SessionId | undefined;
  let state: CreateAttemptState | 'unavailable' | 'timeout' = 'committing';
  const statuses: SessionId[] = [];
  let aborts = 0;
  const host: HostCreateCallbacks = {
    async prepare(id) { uncertain ??= id; return success(); },
    async commit(id) { if (id === uncertain && state !== 'committed') throw new Error('lost response'); return success(); },
    async status(id) { statuses.push(id); if (state === 'unavailable') throw new Error('host offline'); if (state === 'timeout') return new Promise(() => {}); return state; },
    async abort() { aborts++; },
  };
  const checkpoints: Checkpoints = { init: async () => success(), destroy: async () => success(),
    commit: async () => ({ ok: false, error: { code: 'commit_failed', detail: 'fixture' } }), list: async () => ok([]), restore: async () => { throw new Error('not called'); } };
  let active: { core: SessionCore; store: SessionStore } | undefined;
  const close = async () => { if (active) { await active.core.shutdown(); await active.store.close(); active = undefined; } };
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  async function boot() {
    await close();
    const opened = await createFsSessionStore(config, () => null); assert.ok(opened.ok);
    const store = wrapStore(opened.value);
    const core = createSessionCore({ config, store, checkpoints, hostCreate: host, hostAttemptTimeoutMs: 5,
      createAdapter: () => ok({ vendor: 'fixture', policy: { mode: 'interactive', sandbox: null, banner: null }, acceptsAttachments: false, send: async () => success(), respond: success, kill: async () => {} }),
    });
    active = { core, store };
    assert.ok((await core.boot()).ok);
    return core;
  }
  const input = { vendor: 'fixture', cwd: root, model: null, sandbox: null };
  async function unknown(core: SessionCore) {
    const result = await core.create('alice', input);
    assert.ok(!result.ok && result.error.code === 'create_outcome_unknown');
    return result.error.sessionId;
  }
  const events = async (core: SessionCore, id: SessionId) => { const found = []; for await (const e of core.admin.readEvents(id)) { assert.ok(e.ok); found.push(e.value); } return found; };
  return { root, input, boot, unknown, events, statuses, state: (value: typeof state) => { state = value; }, aborts: () => aborts };
}

for (const outcome of ['committing', 'unavailable', 'timeout'] as const) {
  test(`#375 — filesystem restart keeps ${outcome} create hidden, immutable and allocated`, async t => {
    const f = await fixture(t), first = await f.boot(), id = await f.unknown(first);
    f.state(outcome); f.statuses.length = 0;
    for (let restart = 0; restart < 2; restart++) {
      const core = await f.boot();
      assert.deepEqual(core.list('alice'), []);
      assert.deepEqual(core.listPage('alice', null, 10).items, []);
      const get = core.get(id, 'alice'); assert.ok(!get.ok); assert.equal(get.error.code, 'not_found');
      assert.ok(core.admin.snapshot(id));
      for (const result of [await core.send(id, 'alice', 'x', []), await core.end(id, 'alice'), await core.remove(id, 'alice'), await core.admin.remove(id), await core.admin.reassignPrincipal(id, 'bob'),
        await core.restore(id, 'alice', 'a'.repeat(40) as never),
        await core.events.append(id, 'alice', 'session.notice', { level: 'info', code: 'usage_unavailable', text: 'blocked' }),
        core.attachments.begin(id, 'alice', { filename: 'a', mediaType: 'text/plain', sizeBytes: 1 })]) {
        assert.ok(!result.ok); assert.equal(result.error.code, 'turn_in_flight');
      }
      const retry = await core.create('alice', f.input);
      assert.ok(!retry.ok); assert.equal(retry.error.code, 'workspace_busy');
      assert.deepEqual(await f.events(core, id), [], 'unknown create gets no synthetic D130 history');
    }
    assert.deepEqual(f.statuses, [id, id]); assert.equal(f.aborts(), 0);
  });
}

test('#375 — committed reconciliation publishes ended history with D130 exactly once', async t => {
  const f = await fixture(t), first = await f.boot(), id = await f.unknown(first);
  f.state('committed'); f.statuses.length = 0;
  const recovered = await f.boot();
  assert.deepEqual(f.statuses, [id]);
  assert.equal(recovered.list('alice').length, 1); assert.equal(recovered.listPage('alice', null, 10).items.length, 1);
  const found = recovered.get(id, 'alice'); assert.ok(found.ok); assert.equal(found.value.state, 'ended');
  const before = await f.events(recovered, id);
  assert.equal(before.filter(e => e.kind === 'session.notice' && e.data.code === 'server_restart').length, 1);
  const again = await f.boot(); assert.deepEqual(await f.events(again, id), before);
  assert.deepEqual(f.statuses, [id], 'confirmed attempts no longer need reconciliation'); assert.equal(f.aborts(), 0);
});

test('#375 — failed publication retains quarantine until committed status can be recovered', async t => {
  let fail = true;
  const f = await fixture(t, store => ({ ...store, createAttempts: { ...store.createAttempts,
    async remove(id) { return fail ? { ok: false, error: { code: 'io', path: id, detail: 'fixture publication failure' } } : store.createAttempts.remove(id); },
  } }));
  f.state('committed');
  const first = await f.boot(), created = await first.create('alice', f.input);
  assert.ok(!created.ok); assert.equal(created.error.code, 'storage');
  assert.deepEqual(first.list('alice'), []);
  const overlap = await first.create('alice', f.input); assert.ok(!overlap.ok); assert.equal(overlap.error.code, 'workspace_busy');
  fail = false;
  const recovered = await f.boot(); assert.equal(recovered.list('alice').length, 1);
  assert.equal(f.statuses.length, 1); assert.equal(f.aborts(), 0);
});

test('#375 — failed aborted cleanup retains allocation and is retried at the next boot', async t => {
  let fail = true;
  const f = await fixture(t, store => ({ ...store,
    async deleteSession(id) { return fail ? { ok: false, error: { code: 'io', path: id, detail: 'fixture deletion failure' } } : store.deleteSession(id); },
  }));
  const first = await f.boot(), id = await f.unknown(first); f.state('aborted');
  const held = await f.boot(); assert.deepEqual(held.list('alice'), []);
  const overlap = await held.create('alice', f.input); assert.ok(!overlap.ok); assert.equal(overlap.error.code, 'workspace_busy');
  fail = false;
  const recovered = await f.boot(); assert.equal(recovered.admin.snapshot(id), null);
  assert.ok((await recovered.create('alice', f.input)).ok);
});

test('#375 — aborted reconciliation removes pending storage and permits an actual retry', async t => {
  const f = await fixture(t), first = await f.boot(), id = await f.unknown(first);
  f.state('aborted'); f.statuses.length = 0;
  const core = await f.boot();
  assert.deepEqual(f.statuses, [id]); assert.deepEqual(core.list('alice'), []); assert.equal(core.admin.snapshot(id), null);
  await assert.rejects(readFile(path.join(f.root, 'sessions', id, 'meta.json')), { code: 'ENOENT' });
  assert.ok((await core.create('alice', f.input)).ok); assert.equal(f.aborts(), 0);
});

test('#375 — ordinary successful sessions keep existing boot and D130 semantics', async t => {
  const f = await fixture(t); f.state('committed');
  const first = await f.boot(), created = await first.create('alice', f.input); assert.ok(created.ok);
  const id = created.value.sessionId;
  assert.ok((await first.send(id, 'alice', 'open turn', [])).ok);
  const core = await f.boot(), found = core.get(id, 'alice'); assert.ok(found.ok); assert.equal(found.value.state, 'ended');
  const history = await f.events(core, id);
  assert.deepEqual(history.slice(-2).map(e => e.kind), ['session.notice', 'turn.ended']);
  assert.ok(history.some(e => e.kind === 'turn.ended' && e.data.stopReason === 'server_restart'));
  assert.deepEqual(f.statuses, [], 'successful metadata is not reclassified as an attempt');
  const again = await f.boot(); assert.deepEqual(await f.events(again, id), history);
});
