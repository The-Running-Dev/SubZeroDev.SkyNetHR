import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createStore } from './index.js';
import type { Config, Envelope, SessionRecord } from '../contract/index.js';

function baseConfig(storageRoot: string): Config {
  return {
    bind: { host: '127.0.0.1', port: 3000 },
    auth: { mode: 'shared-secret', cookieName: 'skynet', secret: 'x' },
    workspaceRoots: [],
    storageRoot,
    allowedOrigins: [],
    trustProxy: [],
    caps: {
      ringCapacity: 10,
      toolResultBytes: 1024,
      subscriberQueueHighWater: 100,
      keepaliveMs: 15000,
      auditPageMax: 200,
      reviewBodyBytes: 1024,
      requisitionTextBytes: 1024,
    },
    includeRaw: false,
    sessionTokenBudget: null,
    checklist: [],
  };
}

function sessionRecord(id: string): SessionRecord {
  return {
    id: id as never,
    owner: 'op-1' as never,
    vendor: 'claude',
    cwd: 'C:\\workspace\\proj' as never,
    model: null,
    policy: { mode: 'interactive', sandbox: null, banner: null },
    sandbox: null,
    cliSessionId: null,
    lastSeq: 0,
    state: 'live',
    createdAt: new Date().toISOString() as never,
    endedAt: null,
  };
}

function envelope(sessionId: string, seq: number): Envelope {
  return {
    seq: seq as never,
    sessionId: sessionId as never,
    ts: new Date().toISOString() as never,
    kind: 'message',
    data: { turnId: 't1' as never, role: 'user', text: `line ${seq}` },
  };
}

test('S1.8 — meta.json is written once at create (atomic rename) and not per event; events.ndjson holds one parseable envelope per line, seq ascending contiguously from 1', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const storeResult = await createStore(baseConfig(storageRoot));
  assert.equal(storeResult.ok, true);
  if (!storeResult.ok) return;
  const store = storeResult.value;

  const record = sessionRecord('sess-1');
  const created = await store.createSession(record);
  assert.equal(created.ok, true);

  // No temp file left behind by the atomic write.
  const dirEntries = await readdir(path.join(storageRoot, 'sessions', 'sess-1'));
  assert.ok(dirEntries.includes('meta.json'));
  assert.ok(!dirEntries.some((f) => f.includes('.tmp')));

  for (let seq = 1; seq <= 25; seq++) {
    const appended = await store.appendEvent(record.id, envelope('sess-1', seq));
    assert.equal(appended.ok, true);
  }

  const metaAfter = JSON.parse(await readFile(path.join(storageRoot, 'sessions', 'sess-1', 'meta.json'), 'utf8'));
  assert.equal(metaAfter.schemaVersion, 1);
  assert.equal(metaAfter.session.id, 'sess-1');

  const eventsRaw = await readFile(path.join(storageRoot, 'sessions', 'sess-1', 'events.ndjson'), 'utf8');
  const lines = eventsRaw.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 25);
  const parsed = lines.map((l) => JSON.parse(l) as Envelope);
  const seqs = parsed.map((e) => e.seq);
  assert.deepEqual(
    seqs,
    Array.from({ length: 25 }, (_, i) => i + 1),
  );

  const lastSeq = await store.readLastSeq(record.id);
  assert.equal(lastSeq.ok, true);
  if (lastSeq.ok) assert.equal(lastSeq.value, 25);
});

test('openToolOutput on a missing blob returns not_found, not a stream that errors later', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const storeResult = await createStore(baseConfig(storageRoot));
  if (!storeResult.ok) return;
  const store = storeResult.value;
  const record = sessionRecord('sess-3');
  await store.createSession(record);

  const opened = await store.openToolOutput(record.id, 't1' as never, 'call-1' as never);
  assert.equal(opened.ok, false);
  if (!opened.ok) assert.equal(opened.error.code, 'not_found');
});

test('tool-output ids that are not a single path segment are refused; a plain id round-trips', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const storeResult = await createStore(baseConfig(storageRoot));
  if (!storeResult.ok) return;
  const store = storeResult.value;
  const record = sessionRecord('sess-4');
  await store.createSession(record);

  for (const evil of ['..', '../evil', '..\\evil', 'a/b', 'a\\b']) {
    const wrote = await store.writeToolOutput(record.id, 't1' as never, evil as never, Buffer.from('x'));
    assert.equal(wrote.ok, false, `writeToolOutput accepted callId ${JSON.stringify(evil)}`);
    const openedEvil = await store.openToolOutput(record.id, evil as never, 'call-1' as never);
    assert.equal(openedEvil.ok, false, `openToolOutput accepted turnId ${JSON.stringify(evil)}`);
    if (!openedEvil.ok) assert.equal(openedEvil.error.code, 'not_found');
  }

  const wrote = await store.writeToolOutput(record.id, 't1' as never, 'call-1' as never, Buffer.from('hello'));
  assert.equal(wrote.ok, true);
  const opened = await store.openToolOutput(record.id, 't1' as never, 'call-1' as never);
  assert.equal(opened.ok, true);
  if (opened.ok) {
    const chunks: Buffer[] = [];
    for await (const chunk of opened.value) chunks.push(chunk as Buffer);
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'hello');
  }
});

test('S1.8 — a torn trailing line in events.ndjson is dropped, not fatal, at read time', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const storeResult = await createStore(baseConfig(storageRoot));
  if (!storeResult.ok) return;
  const store = storeResult.value;
  const record = sessionRecord('sess-2');
  await store.createSession(record);
  await store.appendEvent(record.id, envelope('sess-2', 1));
  await store.appendEvent(record.id, envelope('sess-2', 2));

  const eventsPath = path.join(storageRoot, 'sessions', 'sess-2', 'events.ndjson');
  const existing = await readFile(eventsPath, 'utf8');
  const { appendFile } = await import('node:fs/promises');
  await appendFile(eventsPath, '{"seq":3,"sessionId":"sess-2","incomplete');
  void existing;

  const collected: Envelope[] = [];
  for await (const result of store.readEventsAfter(record.id, 0 as never)) {
    assert.equal(result.ok, true);
    if (result.ok) collected.push(result.value);
  }
  assert.equal(collected.length, 2);
});

test('S3.6 — a torn trailing line is dropped, the preceding lines are served, and the file is not modified by the read', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const storeResult = await createStore(baseConfig(storageRoot));
  if (!storeResult.ok) return;
  const store = storeResult.value;
  const record = sessionRecord('sess-6');
  await store.createSession(record);
  await store.appendEvent(record.id, envelope('sess-6', 1));
  await store.appendEvent(record.id, envelope('sess-6', 2));

  const eventsPath = path.join(storageRoot, 'sessions', 'sess-6', 'events.ndjson');
  const { appendFile } = await import('node:fs/promises');
  await appendFile(eventsPath, '{"seq":3,"sessionId":"sess-6","tor');
  const beforeRead = await readFile(eventsPath, 'utf8');

  const collected: Envelope[] = [];
  for await (const result of store.readEventsAfter(record.id, 0 as never)) {
    assert.equal(result.ok, true);
    if (result.ok) collected.push(result.value);
  }
  assert.deepEqual(collected.map((e) => e.seq), [1, 2]);

  const afterRead = await readFile(eventsPath, 'utf8');
  assert.equal(afterRead, beforeRead, 'a read must not modify the spill file');
});

test('S3.5 — the ring buffer is a strict suffix of the spill, envelope for envelope, over 500+ envelopes at capacity 100', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const config = baseConfig(storageRoot);
  const capped: Config = { ...config, caps: { ...config.caps, ringCapacity: 100 } };
  const storeResult = await createStore(capped);
  if (!storeResult.ok) return;
  const store = storeResult.value;
  const record = sessionRecord('sess-7');
  await store.createSession(record);

  for (let seq = 1; seq <= 523; seq++) {
    const e = envelope('sess-7', seq);
    // Mirrors `session-manager.emit`'s order: ring push happens alongside the durable
    // append, which is what makes the ring a suffix of the spill in the first place.
    store.pushRing(record.id, e);
    await store.appendEvent(record.id, e);
  }

  const ringTail = store.readRingAfter(record.id, 423 as never);
  assert.notEqual(ringTail, null);
  const spillTail: Envelope[] = [];
  for await (const result of store.readEventsAfter(record.id, 423 as never)) {
    assert.equal(result.ok, true);
    if (result.ok) spillTail.push(result.value);
  }
  assert.equal(ringTail!.length, 100);
  assert.equal(spillTail.length, 100);
  assert.deepEqual(ringTail, spillTail);
});
