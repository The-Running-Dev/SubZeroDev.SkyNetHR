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
async function root(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-store-'));
  const closers: (() => Promise<void>)[] = [];
  // One teardown owns the ordering on every supported Node version: append handles
  // and leases must close before Windows can remove their containing directory.
  t.after(async () => {
    for (const close of closers) await close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, beforeRemove: (close: () => Promise<void>) => { closers.push(close); } };
}
const configuration = (dir: string): RuntimeOptions => ({ storageRoot: dir as never, workspaceRoots: [dir as never], caps, includeRaw: false, streamDeltas: false });
const record: SessionRecord = { id: 'fixture-session' as SessionId, owner: 'opaque:alice', vendor: 'fixture', cwd: '/fixture' as never, model: null, policy: { mode: 'interactive', sandbox: null, banner: null }, sandbox: null, cliSessionId: null, lastSeq: 0, state: 'live', createdAt: '2020-01-01T00:00:00.000Z' as never, endedAt: null, endReason: null, name: null };
const envelope = (seq: number): Envelope => ({ seq: seq as never, sessionId: record.id, ts: record.createdAt, kind: 'session.notice', data: { level: 'info', code: 'usage_unavailable', text: String(seq) } });
async function bytes(stream: NodeJS.ReadableStream) { const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }

for (const backend of ['fs', 'memory'] as const) {
  test(`SessionStore ${backend} — metadata, ordered replay, ring, blobs, audit and ledger conformance`, async t => {
    const { dir, beforeRemove } = await root(t), config = configuration(dir);
    let store: SessionStore;
    if (backend === 'memory') store = createMemorySessionStore(config);
    else { const created = await createFsSessionStore(config, () => null); assert.ok(created.ok); store = created.value; }
    beforeRemove(() => store.close());
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

    // Two-pass correctness (D254): a windowed read's bytes must match a manual slice of the
    // whole blob, and totals (D253) must equal a manual line/byte count of the whole blob.
    const lines = ['first', 'second', 'third', 'fourth', 'fifth'];
    const blob = Buffer.from(lines.map(l => l + '\n').join(''));
    const windowTurn = 'window-turn' as never, windowCall = 'window-call' as never;
    assert.ok((await store.writeToolOutput(record.id, windowTurn, windowCall, blob)).ok);
    const wholeManual = blob.toString();
    const manualLineStarts = [0, ...[...blob].reduce<number[]>((acc, byte, i) => { if (byte === 0x0a) acc.push(i + 1); return acc; }, [])].slice(0, -1);
    const manualSlice = (fromLine: number, lineCount: number | null) => {
      const start = manualLineStarts[fromLine - 1]!;
      const end = lineCount === null ? blob.length : (manualLineStarts[fromLine - 1 + lineCount] ?? blob.length);
      return blob.subarray(start, end).toString();
    };
    const midWindow = await store.openToolOutputWindow(record.id, windowTurn, windowCall, { fromLine: 2, lineCount: 2 });
    assert.ok(midWindow.ok);
    assert.equal((await bytes(midWindow.value.stream)).toString(), manualSlice(2, 2));
    assert.equal(midWindow.value.totals, null); // scan stopped short of the true end (D253)

    const tailWindow = await store.openToolOutputWindow(record.id, windowTurn, windowCall, { fromLine: 4, lineCount: null });
    assert.ok(tailWindow.ok);
    assert.equal((await bytes(tailWindow.value.stream)).toString(), manualSlice(4, null));
    assert.deepEqual(tailWindow.value.totals, { lines: lines.length, bytes: blob.length }); // reached true end

    const fullWindow = await store.openToolOutputWindow(record.id, windowTurn, windowCall, { fromLine: 1, lineCount: null });
    assert.ok(fullWindow.ok);
    assert.equal((await bytes(fullWindow.value.stream)).toString(), wholeManual);
    assert.deepEqual(fullWindow.value.totals, { lines: lines.length, bytes: blob.length });

    // I69 \u2014 a window starting past the last line is a success (empty body), not an error.
    const pastEnd = await store.openToolOutputWindow(record.id, windowTurn, windowCall, { fromLine: lines.length + 10, lineCount: 3 });
    assert.ok(pastEnd.ok);
    assert.equal((await bytes(pastEnd.value.stream)).toString(), '');
    assert.deepEqual(pastEnd.value.totals, { lines: lines.length, bytes: blob.length });

    // statToolOutput (D255): one stat, no scan, no line count.
    const stat = await store.statToolOutput(record.id, windowTurn, windowCall);
    assert.ok(stat.ok);
    assert.deepEqual(stat.value, { bytes: blob.length });
    assert.equal((await store.statToolOutput(record.id, windowTurn, 'missing' as never)).ok, false);
    assert.equal((await store.openToolOutputWindow(record.id, windowTurn, 'missing' as never, { fromLine: 1, lineCount: null })).ok, false);

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
  const { dir, beforeRemove } = await root(t), legacy = path.join(dir, 'server.lock');
  await writeFile(legacy, 'legacy host lease');
  const first = createFsRuntimeLease(dir, () => null), second = createFsRuntimeLease(dir, () => null);
  beforeRemove(async () => { await first.release(); await second.release(); });
  assert.ok((await first.claim()).ok);
  const started = Date.now(), refused = await second.claim();
  assert.ok(!refused.ok && refused.error.code === 'storage_locked');
  assert.equal(refused.error.holder.pid, process.pid); assert.ok(refused.error.age >= 0);
  assert.ok(Date.now() - started < 10_000, 'no fixed twelve-second observation window');
  assert.equal(await readFile(legacy, 'utf8'), 'legacy host lease');
  await first.release(); assert.ok((await second.claim()).ok);
  await second.release(); assert.equal(await readFile(legacy, 'utf8'), 'legacy host lease');
});

test('D262 — a foreign-hostname runtime lease is reclaimed only for a displaced server.lock generation', async t => {
  const { dir, beforeRemove } = await root(t);
  const leaseDir = path.join(dir, 'runtime-leases');
  await mkdir(leaseDir, { recursive: true });
  async function writeForeignHolder(id: string, extra: Record<string, unknown>) {
    const holder = { instanceId: id, pid: 999999, hostname: 'other-host', startedAt: '2020-01-01T00:00:00.000Z', osCreatedAt: null, ...extra };
    await writeFile(path.join(leaseDir, id + '.json'), JSON.stringify(holder));
  }

  // Pre-D262 fixture: no `serverLockInstanceId` field at all (D196) — reclaimed once
  // this claimant holds any server.lock generation.
  await writeForeignHolder('legacy-holder', {});
  const legacy = createFsRuntimeLease(dir, () => 'generation-a');
  assert.ok((await legacy.claim()).ok);
  await legacy.release();
  await rm(path.join(leaseDir, 'legacy-holder.json'), { force: true });

  // Holder names a server.lock generation different from the one this claimant
  // currently holds: reclaimed (D262's displaced-generation ground).
  await writeForeignHolder('displaced-holder', { serverLockInstanceId: 'generation-a' });
  const displaced = createFsRuntimeLease(dir, () => 'generation-b');
  assert.ok((await displaced.claim()).ok);
  await displaced.release();
  await rm(path.join(leaseDir, 'displaced-holder.json'), { force: true });

  // Same generation: still the live holder from this host's own server.lock — fails closed.
  await writeForeignHolder('same-gen-holder', { serverLockInstanceId: 'generation-a' });
  const sameGen = createFsRuntimeLease(dir, () => 'generation-a');
  beforeRemove(() => sameGen.release());
  const sameGenResult = await sameGen.claim();
  assert.ok(!sameGenResult.ok && sameGenResult.error.code === 'storage_locked');
  await rm(path.join(leaseDir, 'same-gen-holder.json'), { force: true });

  // No server.lock held by this claimant: fails closed regardless of the holder's generation.
  await writeForeignHolder('displaced-holder', { serverLockInstanceId: 'generation-a' });
  const noLock = createFsRuntimeLease(dir, () => null);
  beforeRemove(() => noLock.release());
  const noLockResult = await noLock.claim();
  assert.ok(!noLockResult.ok && noLockResult.error.code === 'storage_locked');
  await rm(path.join(leaseDir, 'displaced-holder.json'), { force: true });

  // Standalone writer (`serverLockInstanceId: null`): always fails closed on a foreign
  // hostname, even though this claimant holds a server.lock.
  await writeForeignHolder('standalone-holder', { serverLockInstanceId: null });
  const standalone = createFsRuntimeLease(dir, () => 'generation-a');
  beforeRemove(() => standalone.release());
  const standaloneResult = await standalone.claim();
  assert.ok(!standaloneResult.ok && standaloneResult.error.code === 'storage_locked');
});

test('pre-cutover fixture — full boot rebuilds ended history without rewriting stored bytes', async t => {
  const { dir, beforeRemove } = await root(t), config = configuration(dir);
  const fixture = JSON.parse(await readFile(path.join(process.cwd(), 'src/agent-console/store/fixtures/pre-cutover.json'), 'utf8')) as { meta: SessionMetaFile; events: Envelope[] };
  const sessionDir = path.join(dir, 'sessions', fixture.meta.session.id); await mkdir(sessionDir, { recursive: true });
  const meta = JSON.stringify(fixture.meta), events = fixture.events.map(e => JSON.stringify(e)).join('\n') + '\n';
  await writeFile(path.join(sessionDir, 'meta.json'), meta); await writeFile(path.join(sessionDir, 'events.ndjson'), events);
  const created = await createFsSessionStore(config, () => null); assert.ok(created.ok); const store = created.value; beforeRemove(() => store.close());
  const checkpoints = new Proxy({} as Checkpoints, { get() { return () => assert.fail('ended boot must not invoke checkpoints'); } });
  const core = createSessionCore({ config, store, checkpoints, hostCreate: createHostAttempts({ prepare() { return { ok: true, value: undefined }; }, async commit() { return { ok: true, value: undefined }; }, abort() {} }), createAdapter() { assert.fail('ended boot never creates a provider'); } });
  assert.ok((await core.boot()).ok);
  const found = core.get(fixture.meta.session.id, fixture.meta.session.owner); assert.ok(found.ok); assert.equal(found.value.lastSeq, 2); assert.equal(found.value.state, 'ended');
  const received: Envelope[] = []; assert.ok((await core.subscribe(fixture.meta.session.id, fixture.meta.session.owner, 0, { deliver(e) { if ('seq' in e) received.push(e); }, close() {} })).ok);
  assert.deepEqual(received, fixture.events);
  assert.equal(await readFile(path.join(sessionDir, 'meta.json'), 'utf8'), meta);
  assert.equal(await readFile(path.join(sessionDir, 'events.ndjson'), 'utf8'), events);
});
