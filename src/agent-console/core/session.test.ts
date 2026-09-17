import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSessionCore } from './index.js';
import { createHostAttempts, coordinateHostAttempts, type HostCreateCallbacks } from './create-attempts.js';
import { createMemorySessionStore } from '../store/memory.js';
import { createAttachmentStaging } from './attachments.js';
import type { Adapter, AdapterOptions, AttachmentPayload, Checkpoint, Checkpoints, Envelope, GitSha, IsoTimestamp, Result, RuntimeOptions, SessionError, SessionId, SessionStore, TurnId } from './types.js';

export const caps = { ringCapacity: 20, toolResultBytes: 1024, subscriberQueueHighWater: 20, auditPageMax: 10, standingRuleBytes: 1024, attachmentBytes: 1024, attachmentCount: 2, sessionToolOutputBytes: 4096 };
const ok = <T>(value: T) => ({ ok: true as const, value });
const success = () => ok(undefined);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const checkpoint: Checkpoint = { sha: 'a'.repeat(40) as GitSha, label: 'fixture', ts: '2020-01-01T00:00:00.000Z' as IsoTimestamp };
const checkpointBackend: Checkpoints = { async init() { return success(); }, async commit() { return ok(checkpoint); }, async list() { return ok([checkpoint]); }, async restore() { return ok({ safety: checkpoint, unreached: [] }); }, async destroy() { return success(); } };
function noEffects() { return createHostAttempts({ prepare: success, async commit() { return success(); }, abort() {} }); }
function error(result: Result<unknown, SessionError>, code: SessionError['code']) { assert.ok(!result.ok); assert.equal(result.error.code, code); }

async function fixture(t: TestContext, options: { host?: HostCreateCallbacks; max?: number; checkpoints?: Partial<Checkpoints>; sendFailure?: boolean; wrapStore?: (store: SessionStore) => SessionStore } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-core-')));
  const config: RuntimeOptions = { storageRoot: root as never, workspaceRoots: [root as never], caps, includeRaw: false, streamDeltas: false, maxLiveSessionsPerWorkspace: options.max ?? 1 };
  const store = (options.wrapStore ?? (s => s))(createMemorySessionStore(config));
  let adapterOptions!: AdapterOptions;
  let kills = 0;
  let response: ReturnType<Adapter['respond']> = success();
  let sent: readonly AttachmentPayload[] = [];
  const adapter: Adapter = {
    vendor: 'fixture', policy: { mode: 'interactive', sandbox: null, banner: null }, acceptsAttachments: true,
    async send(_text, attachments) { sent = attachments; return options.sendFailure ? { ok: false, error: { code: 'agent_unavailable', image: 'fixture', detail: 'cannot spawn' } } : success(); },
    respond() { return response; }, async kill() { kills++; },
  };
  const core = createSessionCore({ config, store, checkpoints: { ...checkpointBackend, ...options.checkpoints }, hostCreate: options.host ?? noEffects(), hostAttemptTimeoutMs: 5, createAdapter: (_id, value) => { adapterOptions = value; return ok(adapter); } });
  t.after(async () => { await core.shutdown(); await store.close(); await rm(root, { recursive: true, force: true }); });
  const input = { vendor: 'fixture', cwd: root, model: null, sandbox: null };
  const create = async () => { const created = await core.create('alice', input); assert.ok(created.ok); return created.value.sessionId; };
  const events = async (id: SessionId) => { const values: Envelope[] = []; for await (const e of core.admin.readEvents(id)) { assert.ok(e.ok); values.push(e.value); } return values; };
  const notify = (n: Parameters<AdapterOptions['notify']>[0]) => adapterOptions.notify(n);
  return { core, store, input, create, events, notify, kills: () => kills, sent: () => sent, response: (value: typeof response) => { response = value; } };
}

test('A11 — a pending prepare owns allocation before the host callback and releases on failure', async t => {
  const entered = deferred<void>(), preparation = deferred<Result<void, unknown>>();
  const host = createHostAttempts({ prepare() { entered.resolve(); return preparation.promise; }, async commit() { return success(); }, abort() {} });
  const f = await fixture(t, { host });
  const creating = f.core.create('alice', f.input);
  await entered.promise;
  error(await f.core.create('bob', f.input), 'workspace_busy');
  preparation.resolve({ ok: false, error: 'refused' });
  error(await creating, 'host_create');
  const retry = await f.core.create('alice', f.input);
  error(retry, 'host_create');
});

test('A11/A22 — restore reserves exclusively and refuses send/end/remove/restore until finally', async t => {
  const entered = deferred<void>(), restore = deferred<ReturnType<typeof ok<{ safety: Checkpoint; unreached: [] }>>>();
  const f = await fixture(t, { max: 2, checkpoints: { restore() { entered.resolve(); return restore.promise; } } });
  const id = await f.create();
  const restoring = f.core.restore(id, 'alice', checkpoint.sha);
  await entered.promise;
  for (const action of [() => f.core.send(id, 'alice', 'x', []), () => f.core.end(id, 'alice'), () => f.core.remove(id, 'alice'), () => f.core.restore(id, 'alice', checkpoint.sha)]) error(await action(), 'turn_in_flight');
  error(await f.core.create('bob', f.input), 'workspace_busy');
  restore.resolve(ok({ safety: checkpoint, unreached: [] }));
  assert.ok((await restoring).ok);
  assert.ok((await f.core.create('bob', f.input)).ok);
  error(await f.core.restore(id, 'alice', checkpoint.sha), 'workspace_busy');
});

test('A22 — restore releases both reservations when an extension throws', async t => {
  const f = await fixture(t, { max: 2, checkpoints: { async restore() { throw Error('fixture'); } } });
  const id = await f.create();
  await assert.rejects(f.core.restore(id, 'alice', checkpoint.sha), /fixture/);
  assert.ok((await f.core.create('bob', f.input)).ok);
  assert.ok((await f.core.end(id, 'alice')).ok);
});

test('A22 — send claims synchronously; stale interrupt is inert and end/remove refuse an active turn', async t => {
  const f = await fixture(t), id = await f.create();
  const sending = f.core.send(id, 'alice', 'hello', []);
  error(await f.core.send(id, 'alice', 'raced', []), 'turn_in_flight');
  error(await f.core.end(id, 'alice'), 'turn_in_flight');
  error(await f.core.remove(id, 'alice'), 'turn_in_flight');
  assert.ok((await f.core.interrupt(id, 'alice', 'stale' as TurnId)).ok);
  assert.equal(f.kills(), 0);
  const sent = await sending; assert.ok(sent.ok);
  assert.ok((await f.core.interrupt(id, 'alice', sent.value.turnId)).ok);
  assert.equal(f.kills(), 1);
  f.notify({ kind: 'event', event: { kind: 'turn.ended', data: { stopReason: 'completed', usage: null } } });
  assert.equal(f.kills(), 2, 'completion kill is issued before notification returns');
  assert.ok((await f.core.end(id, 'alice')).ok);
  assert.ok((await f.core.end(id, 'alice')).ok);
  assert.equal((await f.events(id)).filter(e => e.kind === 'session.ended').length, 1);
});

test('A5/A22 — unknown commit outcome is hidden from ordinary reads and retains quarantine', async t => {
  const never = new Promise<never>(() => {});
  const host: HostCreateCallbacks = { async prepare() { return success(); }, commit: () => never, async status() { return 'committing'; }, async abort() { assert.fail('must not abort uncertain commit'); } };
  const f = await fixture(t, { host });
  const created = await f.core.create('alice', f.input);
  assert.ok(!created.ok && created.error.code === 'create_outcome_unknown');
  const id = created.error.sessionId;
  assert.equal(f.core.admin.snapshot(id)?.id, id, 'recovery keeps internal visibility');
  error(await f.core.end(id, 'alice'), 'turn_in_flight');
  error(await f.core.remove(id, 'alice'), 'turn_in_flight');
  error(await f.core.send(id, 'alice', 'x', []), 'turn_in_flight');
  error(await f.core.restore(id, 'alice', checkpoint.sha), 'turn_in_flight');
  error(await f.core.events.append(id, 'alice', 'session.notice', { level: 'info', code: 'usage_unavailable', text: 'blocked' }), 'turn_in_flight');
  error(f.core.attachments.begin(id, 'alice', { filename: 'x', mediaType: 'text/plain', sizeBytes: 0 }), 'turn_in_flight');
  error(await f.core.admin.remove(id), 'turn_in_flight');
  error(await f.core.admin.reassignPrincipal(id, 'bob'), 'turn_in_flight');
  error(await f.core.create('bob', f.input), 'workspace_busy');
  assert.deepEqual(f.core.list('alice'), []);
  assert.deepEqual(f.core.listPage('alice', null, 1), { items: [], next: null });
  error(f.core.get(id, 'alice'), 'not_found');
  error(await f.core.listCheckpoints(id, 'alice'), 'not_found');
  error(await f.core.subscribe(id, 'alice', 0, { deliver() { assert.fail('quarantined event delivered'); }, close() {} }), 'not_found');
  error(await f.core.openToolOutput(id, 'alice', 'turn' as TurnId, 'call' as never), 'not_found');
  error(await f.core.openAttachment(id, 'alice', 'turn' as TurnId, 'attachment' as never), 'not_found');
});

for (const terminal of ['committed', 'aborted'] as const) {
  test(`A5 — pending create stays hidden until reconciliation reports ${terminal}`, async t => {
    const entered = deferred<SessionId>(), state = deferred<'committed' | 'aborted'>();
    let claimed = false, firstAttempt: SessionId | undefined, aborts = 0;
    const host: HostCreateCallbacks = {
      async prepare(id) { assert.equal(claimed, false); claimed = true; firstAttempt ??= id; return success(); },
      async commit(id) { if (id === firstAttempt) throw Error('lost commit reply'); return success(); },
      status(id) { entered.resolve(id); return state.promise; },
      async abort() { assert.equal(terminal, 'aborted'); claimed = false; aborts++; },
    };
    const f = await fixture(t, { host });
    const creating = f.core.create('alice', f.input);
    const id = await entered.promise;
    // Resolve immediately after synchronous assertions: no timing/sleep dependence.
    const pendingList = f.core.list('alice');
    const pendingPage = f.core.listPage('alice', null, 1);
    const pendingGet = f.core.get(id, 'alice');
    assert.ok(f.core.admin.snapshot(id));
    assert.equal(claimed, true);
    state.resolve(terminal);
    const result = await creating;
    assert.deepEqual(pendingList, []);
    assert.deepEqual(pendingPage, { items: [], next: null });
    error(pendingGet, 'not_found');
    if (terminal === 'committed') {
      assert.ok(result.ok);
      assert.equal(result.value.sessionId, id);
      assert.equal(f.core.list('alice')[0]?.id, id);
      assert.equal(f.core.listPage('alice', null, 1).items[0]?.id, id);
      assert.ok(f.core.get(id, 'alice').ok);
      assert.equal(aborts, 0);
      assert.equal(claimed, true);
      error(await f.core.create('bob', f.input), 'workspace_busy');
    } else {
      error(result, 'host_create');
      assert.equal(f.core.admin.snapshot(id), null);
      assert.deepEqual(await f.store.readAllMeta(), []);
      assert.deepEqual(f.core.list('alice'), []);
      error(f.core.get(id, 'alice'), 'not_found');
      assert.equal(aborts, 1);
      assert.equal(claimed, false);
      assert.equal(f.kills(), 1);
      // Actually retry against the released workspace and host reservation.
      assert.ok((await f.core.create('alice', f.input)).ok);
      assert.equal(claimed, true);
    }
  });
}

test('A5 — prepare timeout cancels then aborts, including a late asynchronous claim', async () => {
  const prepare = deferred<Result<void, unknown>>();
  let claimed = false, cancelled = false;
  const host = createHostAttempts({ prepare(_id, _owner, _data, signal) { signal.addEventListener('abort', () => { cancelled = true; }); return prepare.promise.then(result => { claimed = true; return result; }); }, async commit() { return success(); }, abort() { claimed = false; } });
  const id = 'attempt' as SessionId;
  const result = await coordinateHostAttempts(host, 1).prepare(id, 'alice', null);
  assert.ok(!result.ok); assert.equal(result.error, 'create_prepare_timeout'); assert.ok(cancelled);
  prepare.resolve(success());
  await host.prepare(id, 'alice', null);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(claimed, false); assert.equal(await host.status(id), 'aborted');
});

test('A5 — abort waits for commit; retries and lost replies do not duplicate durable effects', async () => {
  const durable = deferred<Result<void, unknown>>(); let claims = 0, commits = 0, aborts = 0;
  const host = createHostAttempts({ prepare() { claims++; return success(); }, commit() { commits++; return durable.promise; }, abort() { aborts++; } });
  const id = 'attempt' as SessionId;
  const prepared = host.prepare(id, 'alice', null); assert.equal(claims, 1, 'claim is synchronous');
  await prepared; await host.prepare(id, 'alice', null);
  const committing = host.commit(id), aborting = host.abort(id);
  assert.equal(await host.status(id), 'committing');
  durable.resolve(success()); await committing; await aborting;
  assert.ok((await host.commit(id)).ok); assert.equal(commits, 1); assert.equal(aborts, 0);
  const transport: HostCreateCallbacks = { ...host, async commit() { throw Error('lost reply'); } };
  assert.ok((await coordinateHostAttempts(transport, 1).commit(id)).ok);
});

test('A4 — opaque principals, page filtering, reassignment and staged-handle revocation', async t => {
  const f = await fixture(t, { max: 3 }), id = await f.create(); await f.create();
  error(f.core.get(id, 'ALICE'), 'not_found');
  assert.deepEqual(f.core.listPage('bob', null, 1).items, []);
  const page = f.core.listPage('alice', null, 1); assert.equal(page.items.length, 1); assert.ok(page.next);
  assert.equal(f.core.listPage('alice', page.next, 1).items.length, 1);
  const upload = f.core.attachments.begin(id, 'alice', { filename: '../CON', mediaType: 'text/plain', sizeBytes: 0 }); assert.ok(upload.ok);
  assert.ok((await f.core.admin.reassignPrincipal(id, 'opaque:subject/42')).ok);
  error(f.core.get(id, 'alice'), 'not_found');
  error(f.core.attachments.commit(id, 'opaque:subject/42', upload.value), 'not_found');
  assert.ok(f.core.get(id, 'opaque:subject/42').ok);
});

test('attachment staging — exact chunks, caps, expiry, binding, abort and one-use turn consumption', async t => {
  let now = 0;
  const staging = createAttachmentStaging(caps, success, { now: () => now, ttlMs: 5 });
  const a = 'a' as SessionId, b = 'b' as SessionId;
  const upload = staging.api.begin(a, 'alice', { filename: '../../NUL', mediaType: 'text/plain', sizeBytes: 3 }); assert.ok(upload.ok);
  error(staging.api.write(b, 'alice', upload.value, 0, Buffer.from('abc')), 'not_found');
  error(staging.api.write(a, 'bob', upload.value, 0, Buffer.from('abc')), 'not_found');
  error(staging.api.write(a, 'alice', upload.value, 1, Buffer.from('abc')), 'bad_request');
  assert.ok(staging.api.write(a, 'alice', upload.value, 0, Buffer.from('abc')).ok);
  assert.ok(staging.api.commit(a, 'alice', upload.value).ok);
  now = 5; error(staging.take(a, 'alice', [upload.value]), 'not_found');
  const f = await fixture(t), id = await f.create();
  const begun = f.core.attachments.begin(id, 'alice', { filename: '../../NUL', mediaType: 'text/plain', sizeBytes: 3 }); assert.ok(begun.ok);
  assert.ok(f.core.attachments.write(id, 'alice', begun.value, 0, Buffer.from('abc')).ok);
  assert.ok(f.core.attachments.commit(id, 'alice', begun.value).ok);
  assert.ok((await f.core.send(id, 'alice', 'file', [begun.value])).ok);
  assert.equal(f.sent()[0]!.ref.filename, '../../NUL'); assert.equal(Buffer.from(f.sent()[0]!.data).toString(), 'abc');
  error(f.core.attachments.commit(id, 'alice', begun.value), 'not_found');
});

test('A22/D213 — permission response reports cancellation when the process exits during audit', async t => {
  const writing = deferred<void>(), durable = deferred<void>();
  const f = await fixture(t, { wrapStore: store => ({ ...store, async appendAudit(record) { if (record.reason !== 'cancelled_process_exit') { writing.resolve(); await durable.promise; } return store.appendAudit(record); } }) });
  const id = await f.create(); assert.ok((await f.core.send(id, 'alice', 'x', [])).ok);
  f.notify({ kind: 'event', event: { kind: 'permission.request', data: { requestId: 'r' as never, callId: 'c' as never, tool: 'Read', input: {}, matchTarget: null, suggestions: [] } } });
  const answering = f.core.answerPermission(id, 'alice', { requestId: 'r' as never, decision: 'allow', scope: 'once', rule: null, reason: null });
  await writing.promise;
  f.response({ ok: false, error: { code: 'write_failed', detail: 'exited' } });
  f.notify({ kind: 'event', event: { kind: 'turn.ended', data: { stopReason: 'completed', usage: null } } });
  durable.resolve();
  const answered = await answering; assert.ok(answered.ok); assert.equal(answered.value.resolution?.reason, 'cancelled_process_exit');
  const resolved = (await f.events(id)).filter(e => e.kind === 'permission.resolved');
  assert.equal(resolved.length, 1); assert.equal(resolved[0]!.data.reason, 'cancelled_process_exit');
});

test('events.append — duplicate callers receive sequenced durable outcomes and failed storage ends the session', async t => {
  let fail = false;
  const f = await fixture(t, { wrapStore: store => ({ ...store, async appendEvent(id, event) { if (fail) return { ok: false, error: { code: 'io', path: id, detail: 'disk full' } }; return store.appendEvent(id, event); } }) });
  const id = await f.create();
  const data = { level: 'info' as const, code: 'usage_unavailable' as const, text: 'fixture' };
  const [a, b] = await Promise.all([f.core.events.append(id, 'alice', 'session.notice', data), f.core.events.append(id, 'alice', 'session.notice', data)]);
  assert.ok(a.ok && b.ok); assert.equal(b.value.seq, a.value.seq + 1);
  fail = true; error(await f.core.events.append(id, 'alice', 'session.notice', data), 'storage');
  error(await f.core.events.append(id, 'alice', 'session.notice', data), 'session_ended');
});

test('checkpoint operations advertise schemas and mutability; pre-turn failure remains best effort', async t => {
  const f = await fixture(t, { checkpoints: { async commit() { return { ok: false, error: { code: 'commit_failed', detail: 'fixture' } }; } } });
  const id = await f.create();
  assert.deepEqual(f.core.extensions.operations.map(o => [o.name, o.mutates]), [['checkpoints.list', false], ['checkpoints.restore', true]]);
  assert.ok((await f.core.extensions.invoke('checkpoints.list', id, 'alice', {})).ok);
  error(await f.core.extensions.invoke('checkpoints.restore', id, 'alice', { sha: '../bad' }), 'bad_request');
  assert.ok((await f.core.send(id, 'alice', 'still runs', [])).ok);
  assert.ok((await f.events(id)).some(e => e.kind === 'session.notice' && e.data.code === 'checkpoint_skipped'));
});

test('event-order fixtures — happy path, S6.9 checkpoint failure and unspawnable pairing', async t => {
  const expected = JSON.parse(await readFile(path.join(process.cwd(), 'src/agent-console/core/fixtures/event-order.json'), 'utf8')) as Record<string, string[]>;
  for (const scenario of ['happy', 'checkpointFailure', 'unspawnable']) {
    const f = await fixture(t, { sendFailure: scenario === 'unspawnable', ...(scenario === 'checkpointFailure' ? { checkpoints: { async commit() { return { ok: false as const, error: { code: 'commit_failed' as const, detail: 'index.lock' } }; } } } : {}) });
    const id = await f.create(), sent = await f.core.send(id, 'alice', 'hello', []);
    if (scenario !== 'unspawnable') {
      assert.ok(sent.ok);
      f.notify({ kind: 'cli-session', cliSessionId: 'provider-conversation' as never });
      f.notify({ kind: 'event', event: { kind: 'message', data: { role: 'assistant', text: 'hello', attachments: [] } } });
      f.notify({ kind: 'event', event: { kind: 'turn.ended', data: { stopReason: 'completed', usage: null } } });
    } else error(sent, 'adapter');
    assert.ok((await f.core.end(id, 'alice')).ok);
    const events = (await f.events(id)).filter(e => e.kind !== 'session.ended');
    assert.deepEqual(events.map(e => e.kind === 'session.notice' ? `${e.kind}:${e.data.code}` : e.kind === 'error' ? `${e.kind}:${e.data.kind}` : e.kind), expected[scenario]);
    assert.deepEqual(events.map(e => e.seq), events.map((_e, i) => i + 1));
  }
});

test('A22 — reentrant appends preserve durable and every subscriber seq order', async t => {
  const f = await fixture(t), id = await f.create();
  const data = { level: 'info' as const, code: 'usage_unavailable' as const, text: 'fixture' };
  let appended: Promise<unknown> | undefined;
  const first: number[] = [], second: number[] = [];
  await f.core.subscribe(id, 'alice', 0, { deliver(e) { if ('seq' in e) { first.push(e.seq); if (e.seq === 1) appended = f.core.events.append(id, 'alice', 'session.notice', data); } }, close() {} });
  await f.core.subscribe(id, 'alice', 0, { deliver(e) { if ('seq' in e) second.push(e.seq); }, close() {} });
  assert.ok((await f.core.events.append(id, 'alice', 'session.notice', data)).ok); await appended;
  assert.deepEqual((await f.events(id)).map(e => e.seq), [1, 2]);
  assert.deepEqual(first, [1, 2]); assert.deepEqual(second, [1, 2]);
});
