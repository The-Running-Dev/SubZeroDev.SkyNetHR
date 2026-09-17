import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFsSessionStore } from './fs.js';
import { createMemorySessionStore } from './memory.js';
import { createFsRuntimeLease } from './lease.js';
import { createSessionCore } from '../core/index.js';
import { createHostAttempts } from '../core/create-attempts.js';
import type { Checkpoints, Envelope, RuntimeOptions, SessionId, SessionMetaFile, SessionRecord, SessionStore } from '../core/types.js';

const caps = { ringCapacity: 2, toolResultBytes: 1024, subscriberQueueHighWater: 20, auditPageMax: 10, standingRuleBytes: 1024, attachmentBytes: 1024, attachmentCount: 2, sessionToolOutputBytes: 4096 };
async function root(t: TestContext) { const dir = await mkdtemp(path.join(tmpdir(), 'agent-store-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
const configuration = (dir: string): RuntimeOptions => ({ storageRoot: dir as never, workspaceRoots: [dir as never], caps, includeRaw: false, streamDeltas: false });
const record: SessionRecord = { id: 'fixture-session' as SessionId, owner: 'opaque:alice', vendor: 'fixture', cwd: '/fixture' as never, model: null, policy: { mode: 'interactive', sandbox: null, banner: null }, sandbox: null, cliSessionId: null, lastSeq: 0, state: 'live', createdAt: '2020-01-01T00:00:00.000Z' as never, endedAt: null, endReason: null };
const envelope = (seq: number): Envelope => ({ seq: seq as never, sessionId: record.id, ts: record.createdAt, kind: 'session.notice', data: { level: 'info', code: 'usage_unavailable', text: String(seq) } });
async function bytes(stream: NodeJS.ReadableStream) { const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }

for (const backend of ['fs', 'memory'] as const) {
  test(`SessionStore ${backend} — metadata, ordered replay, ring, blobs, audit and ledger conformance`, async t => {
    const dir = await root(t), config = configuration(dir);
    let store: SessionStore;
    if (backend === 'memory') store = createMemorySessionStore(config);
    else { const created = await createFsSessionStore(config); assert.ok(created.ok); store = created.value; }
    t.after(() => store.close());
    assert.ok((await store.createSession(record)).ok);
    assert.deepEqual((await store.readAllMeta())[0]!.result, { ok: true, value: record });
    for (let seq = 1; seq <= 3; seq++) { assert.ok((await store.appendEvent(record.id, envelope(seq))).ok); store.pushRing(record.id, envelope(seq)); }
    assert.equal(store.readRingAfter(record.id, 0), null);
    assert.deepEqual(store.readRingAfter(record.id, 1 as never)?.map(e => e.seq), [2, 3]);
    const replay: number[] = []; for await (const e of store.readEventsAfter(record.id, 1 as never)) { assert.ok(e.ok); replay.push(e.value.seq); }
    assert.deepEqual(replay, [2, 3]); assert.deepEqual(await store.readLastSeq(record.id), { ok: true, value: 3 });
    const turn = 'turn' as never, attachment = 'attachment' as never, call = 'call' as never;
    assert.ok((await store.writeAttachment(record.id, turn, attachment, Buffer.from('image'), 'image/png')).ok);
    const opened = await store.openAttachment(record.id, turn, attachment); assert.ok(opened.ok); assert.equal(opened.value.mediaType, 'image/png'); assert.equal((await bytes(opened.value.stream)).toString(), 'image');
    assert.ok((await store.removeAttachments(record.id, turn)).ok); assert.equal((await store.openAttachment(record.id, turn, attachment)).ok, false);
    assert.ok((await store.writeToolOutput(record.id, turn, call, Buffer.from('tool'))).ok);
    const tool = await store.openToolOutput(record.id, turn, call); assert.ok(tool.ok); assert.equal((await bytes(tool.value)).toString(), 'tool');
    for (const bad of ['../escape', 'CON', 'a:b', 'trailing.', 'e\u0301']) {
      assert.equal((await store.writeAttachment(record.id, turn, bad as never, Buffer.from('x'), 'text/plain')).ok, false);
      assert.equal((await store.openToolOutput(record.id, turn, bad as never)).ok, false);
    }
    const audit = { ts: record.createdAt, operator: record.owner, sessionId: record.id, vendor: record.vendor, sandbox: null, tool: 'Read', input: {}, decision: 'allow' as const, scope: 'once' as const, reason: null };
    assert.ok((await store.appendAudit(audit)).ok);
    const page = await store.readAuditPage({ before: null, limit: 1, sessionId: record.id, operator: record.owner, since: null, until: null, incidentsOnly: false }); assert.ok(page.ok); assert.deepEqual(page.value.records, [audit]);
    const pid = { pid: 12345, pgid: null, sessionId: record.id, turnId: turn, hostname: 'fixture', startedAt: record.createdAt, image: 'fixture', osCreatedAt: null, exitedAt: null };
    assert.ok((await store.appendPid(pid)).ok); assert.deepEqual(await store.readOpenPids(), [pid]);
    assert.ok((await store.tombstonePid(pid.pid, record.createdAt)).ok); assert.deepEqual(await store.readOpenPids(), []);
    assert.ok((await store.deleteSession(record.id)).ok); assert.deepEqual(await store.readAllMeta(), []);
  });
}

test('A13 — runtime lease refuses a second holder immediately and never changes server.lock', async t => {
  const dir = await root(t), legacy = path.join(dir, 'server.lock');
  await writeFile(legacy, 'legacy host lease');
  const first = createFsRuntimeLease(dir), second = createFsRuntimeLease(dir);
  t.after(async () => { await first.release(); await second.release(); });
  assert.ok((await first.claim()).ok);
  const started = Date.now(), refused = await second.claim();
  assert.ok(!refused.ok && refused.error.code === 'storage_locked');
  assert.equal(refused.error.holder.pid, process.pid); assert.ok(refused.error.age >= 0);
  assert.ok(Date.now() - started < 10_000, 'no fixed twelve-second observation window');
  assert.equal(await readFile(legacy, 'utf8'), 'legacy host lease');
  await first.release(); assert.ok((await second.claim()).ok);
  await second.release(); assert.equal(await readFile(legacy, 'utf8'), 'legacy host lease');
});

test('pre-cutover fixture — full boot rebuilds ended history without rewriting stored bytes', async t => {
  const dir = await root(t), config = configuration(dir);
  const fixture = JSON.parse(await readFile(path.join(process.cwd(), 'src/agent-console/store/fixtures/pre-cutover.json'), 'utf8')) as { meta: SessionMetaFile; events: Envelope[] };
  const sessionDir = path.join(dir, 'sessions', fixture.meta.session.id); await mkdir(sessionDir, { recursive: true });
  const meta = JSON.stringify(fixture.meta), events = fixture.events.map(e => JSON.stringify(e)).join('\n') + '\n';
  await writeFile(path.join(sessionDir, 'meta.json'), meta); await writeFile(path.join(sessionDir, 'events.ndjson'), events);
  const created = await createFsSessionStore(config); assert.ok(created.ok); const store = created.value; t.after(() => store.close());
  const checkpoints = new Proxy({} as Checkpoints, { get() { return () => assert.fail('ended boot must not invoke checkpoints'); } });
  const core = createSessionCore({ config, store, checkpoints, hostCreate: createHostAttempts({ prepare() { return { ok: true, value: undefined }; }, async commit() { return { ok: true, value: undefined }; }, abort() {} }), createAdapter() { assert.fail('ended boot never creates a provider'); } });
  assert.ok((await core.boot()).ok);
  const found = core.get(fixture.meta.session.id, fixture.meta.session.owner); assert.ok(found.ok); assert.equal(found.value.lastSeq, 2); assert.equal(found.value.state, 'ended');
  const received: Envelope[] = []; assert.ok((await core.subscribe(fixture.meta.session.id, fixture.meta.session.owner, 0, { deliver(e) { if ('seq' in e) received.push(e); }, close() {} })).ok);
  assert.deepEqual(received, fixture.events);
  assert.equal(await readFile(path.join(sessionDir, 'meta.json'), 'utf8'), meta);
  assert.equal(await readFile(path.join(sessionDir, 'events.ndjson'), 'utf8'), events);
});
