import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createStore, LOCK_RENEWAL_INTERVAL_MS } from './index.js';
import type { AuditCursor, AuditRecord, Config, Envelope, ServerLock, SessionRecord, Store } from '../contract/index.js';

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
      standingRuleBytes: 1024, attachmentBytes: 10485760, attachmentCount: 5, sessionToolOutputBytes: 10485760,
    },
    sessionCookieMaxAgeSeconds: 2592000,
    includeRaw: false,
    streamDeltas: false,
    sessionTokenBudget: null,
    tokenRates: null,
    currency: null,
    checklist: [],
    edge: 'sse',
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

function auditRecord(seq: number, overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, seq)).toISOString() as never,
    operator: 'op-1' as never,
    sessionId: 'sess-1' as never,
    vendor: 'claude',
    sandbox: null,
    tool: 'bash',
    input: { seq },
    decision: 'allow',
    scope: 'once',
    reason: null,
    ...overrides,
  };
}

// `appendAudit` fsyncs every line (durability, D73), which makes it far too slow for a
// fixture of thousands of records — this writes `audit.ndjson` directly instead, which is
// exactly what a real deployment's append does over its whole lifetime, just batched here.
async function writeAuditFixture(storageRoot: string, records: readonly AuditRecord[]): Promise<void> {
  const body = records.map((r) => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : '');
  await writeFile(path.join(storageRoot, 'audit.ndjson'), body, 'utf8');
}

function envelope(sessionId: string, seq: number): Envelope {
  return {
    seq: seq as never,
    sessionId: sessionId as never,
    ts: new Date().toISOString() as never,
    kind: 'message',
    data: { turnId: 't1' as never, role: 'user', text: `line ${seq}`, attachments: [] },
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

test('S21.3/S21.4 — openAttachment on a missing blob returns not_found; a written attachment round-trips bytes and the stored mediaType', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const storeResult = await createStore(baseConfig(storageRoot));
  if (!storeResult.ok) return;
  const store = storeResult.value;
  const record = sessionRecord('sess-5');
  await store.createSession(record);

  const missing = await store.openAttachment(record.id, 't1' as never, 'att-1' as never);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, 'not_found');

  const wrote = await store.writeAttachment(record.id, 't1' as never, 'att-1' as never, Buffer.from('screenshot-bytes'), 'image/png');
  assert.equal(wrote.ok, true);
  const opened = await store.openAttachment(record.id, 't1' as never, 'att-1' as never);
  assert.equal(opened.ok, true);
  if (opened.ok) {
    assert.equal(opened.value.mediaType, 'image/png');
    const chunks: Buffer[] = [];
    for await (const chunk of opened.value.stream) chunks.push(chunk as Buffer);
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'screenshot-bytes');
  }
});

test('S21.4 — attachment ids that are not a single path segment are refused', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const storeResult = await createStore(baseConfig(storageRoot));
  if (!storeResult.ok) return;
  const store = storeResult.value;
  const record = sessionRecord('sess-6b');
  await store.createSession(record);

  for (const evil of ['..', '../evil', '..\\evil', 'a/b', 'a\\b', '\0evil']) {
    const wrote = await store.writeAttachment(record.id, 't1' as never, evil as never, Buffer.from('x'), 'text/plain');
    assert.equal(wrote.ok, false, `writeAttachment accepted attachmentId ${JSON.stringify(evil)}`);
    const openedEvil = await store.openAttachment(record.id, evil as never, 'att-1' as never);
    assert.equal(openedEvil.ok, false, `openAttachment accepted turnId ${JSON.stringify(evil)}`);
    if (!openedEvil.ok) assert.equal(openedEvil.error.code, 'not_found');
  }
});

// #203 — removeAttachments rolls back an entire turn's staged attachments in one call
// (session-manager calls this on a partial-write or spill-append failure, not knowing in
// advance which siblings, if any, reached disk).
test('#203 — removeAttachments removes every attachment staged under a turn, and is a no-op when the turn staged none', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const storeResult = await createStore(baseConfig(storageRoot));
  if (!storeResult.ok) return;
  const store = storeResult.value;
  const record = sessionRecord('sess-203');
  await store.createSession(record);

  await store.writeAttachment(record.id, 't1' as never, 'att-1' as never, Buffer.from('a'), 'text/plain');
  await store.writeAttachment(record.id, 't1' as never, 'att-2' as never, Buffer.from('b'), 'text/plain');
  await store.writeAttachment(record.id, 't2' as never, 'att-3' as never, Buffer.from('c'), 'text/plain');

  const removed = await store.removeAttachments(record.id, 't1' as never);
  assert.equal(removed.ok, true);

  const gone1 = await store.openAttachment(record.id, 't1' as never, 'att-1' as never);
  assert.equal(gone1.ok, false);
  if (!gone1.ok) assert.equal(gone1.error.code, 'not_found');
  const gone2 = await store.openAttachment(record.id, 't1' as never, 'att-2' as never);
  assert.equal(gone2.ok, false);
  if (!gone2.ok) assert.equal(gone2.error.code, 'not_found');

  // A different turn's attachment is untouched.
  const untouched = await store.openAttachment(record.id, 't2' as never, 'att-3' as never);
  assert.equal(untouched.ok, true);
  if (untouched.ok) for await (const _chunk of untouched.value.stream) void _chunk; // drain: closes the handle

  // A turn that staged nothing at all is a no-op, not an error.
  const noop = await store.removeAttachments(record.id, 'never-staged' as never);
  assert.equal(noop.ok, true);
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

test('S9.7 — over 50,000 envelopes the ring never exceeds caps.ringCapacity; peak RSS is measured and reported', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const config = baseConfig(storageRoot);
  const capped: Config = { ...config, caps: { ...config.caps, ringCapacity: 500 } };
  const storeResult = await createStore(capped);
  if (!storeResult.ok) return;
  const store = storeResult.value;
  const record = sessionRecord('sess-9-7');
  await store.createSession(record);

  const N = 50_000;
  let peakRss = 0;
  for (let seq = 1; seq <= N; seq++) {
    const e = envelope('sess-9-7', seq);
    // Mirrors `session-manager.emit`'s order (S3.5).
    store.pushRing(record.id, e);
    await store.appendEvent(record.id, e);
    if (seq % 1000 === 0) {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      const tail = store.readRingAfter(record.id, (seq - 1) as never);
      assert.ok(tail === null || tail.length <= capped.caps.ringCapacity, `ring held ${tail?.length} envelopes at seq ${seq}, over capacity ${capped.caps.ringCapacity}`);
    }
  }

  // Not `after: 0` — a ring trimmed past the start of the run correctly answers that
  // with `null` (S3.5's "cannot serve"), which is not what this assertion is after.
  const finalTail = store.readRingAfter(record.id, (N - capped.caps.ringCapacity) as never);
  assert.notEqual(finalTail, null);
  assert.equal(finalTail!.length, capped.caps.ringCapacity, `the ring holds exactly ringCapacity (${capped.caps.ringCapacity}) envelopes after ${N}`);

  const spillTail: Envelope[] = [];
  for await (const result of store.readEventsAfter(record.id, (N - capped.caps.ringCapacity) as never)) {
    if (result.ok) spillTail.push(result.value);
  }
  assert.deepEqual(finalTail, spillTail, 'the ring is still a strict suffix of the spill at this scale (S3.5)');

  // S9.7: "server peak RSS is stated in the slice report" — measured here, in the process
  // actually holding the ring and driving the appends, and printed for that report.
  console.log(`[S9.7] ${N} envelopes at ringCapacity ${capped.caps.ringCapacity}: peak RSS ${(peakRss / (1024 * 1024)).toFixed(1)} MiB`);
});

// Bulk-written, not appended one envelope at a time — mirrors `writeAuditFixture`'s
// rationale above: this tests `readEventsAfter`, not `appendEvent`, and a real deployment's
// incremental appends produce byte-identical `events.ndjson` content to this at rest.
async function writeEventsFixture(storageRoot: string, sessionId: string, count: number): Promise<void> {
  const lines: string[] = [];
  for (let seq = 1; seq <= count; seq++) lines.push(JSON.stringify(envelope(sessionId, seq)));
  await writeFile(path.join(storageRoot, 'sessions', sessionId, 'events.ndjson'), lines.join('\n') + '\n', 'utf8');
}

test('S24.2 — bytes read to serve a last-100 replay grow with distance from the tail, not with the file (10,000 vs 100,000 envelopes)', async () => {
  async function replayLast100BytesRead(n: number): Promise<{ bytes: number; ms: number; tail: Envelope[] }> {
    const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
    const storeResult = await createStore(baseConfig(storageRoot));
    if (!storeResult.ok) throw new Error('createStore failed');
    const store = storeResult.value;
    const record = sessionRecord('sess-24-2');
    await store.createSession(record);
    await writeEventsFixture(storageRoot, 'sess-24-2', n);

    const before = streamBytesReadTotal;
    const start = Date.now();
    const tail: Envelope[] = [];
    for await (const result of store.readEventsAfter(record.id, (n - 100) as never)) {
      assert.equal(result.ok, true);
      if (result.ok) tail.push(result.value);
    }
    const ms = Date.now() - start;
    return { bytes: streamBytesReadTotal - before, ms, tail };
  }

  // `readEventsAfter`'s forward pass is internal to `store` and not part of `Store`'s
  // public contract, so its byte count cannot be read off a return value. `fs.ReadStream`
  // is a shared, mutable class — unlike `node:fs`'s named exports, which are frozen ESM
  // bindings a test cannot reassign across a module boundary — so patching its prototype
  // tallies `.bytesRead` for every stream any module constructs, including the one inside
  // `readEventsAfter`, without changing `store`'s own source.
  const { ReadStream } = await import('node:fs');
  let streamBytesReadTotal = 0;
  const originalDestroy = ReadStream.prototype._destroy;
  ReadStream.prototype._destroy = function (this: InstanceType<typeof ReadStream>, ...args: Parameters<typeof originalDestroy>) {
    streamBytesReadTotal += this.bytesRead;
    return originalDestroy.apply(this, args);
  };

  let small: { bytes: number; ms: number; tail: Envelope[] };
  let large: { bytes: number; ms: number; tail: Envelope[] };
  try {
    small = await replayLast100BytesRead(10_000);
    large = await replayLast100BytesRead(100_000);
  } finally {
    ReadStream.prototype._destroy = originalDestroy;
  }

  assert.equal(small.tail.length, 100);
  assert.equal(large.tail.length, 100);
  assert.deepEqual(small.tail.map((e) => e.seq - 9_900), large.tail.map((e) => e.seq - 99_900), 'both replays return the same shape — the last 100 envelopes relative to their own file');

  // "Within noise of each other" (S24.2): the file is 10x larger but the replay asked for
  // the same 100-envelope tail, so the byte count must not scale with the file. A generous
  // 3x bound (not 1x) absorbs jitter from chunk-boundary alignment without hiding an O(file)
  // regression, which would show up as roughly a 10x difference.
  console.log(`[S24.2] 10,000 envelopes: ${small.bytes} bytes, ${small.ms}ms to replay last 100`);
  console.log(`[S24.2] 100,000 envelopes: ${large.bytes} bytes, ${large.ms}ms to replay last 100`);
  assert.ok(
    large.bytes < small.bytes * 3,
    `bytes read grew with file size: ${small.bytes} (10,000 envelopes) vs ${large.bytes} (100,000 envelopes)`,
  );
});

test('S24.4 — in a large multi-chunk spill, a torn trailing line is dropped and the file is unmodified, with the tear at the point the backward read starts', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const storeResult = await createStore(baseConfig(storageRoot));
  if (!storeResult.ok) return;
  const store = storeResult.value;
  const record = sessionRecord('sess-24-4');
  await store.createSession(record);

  const N = 20_000; // large enough to span several of `locateForwardStart`'s 64 KiB chunks
  await writeEventsFixture(storageRoot, 'sess-24-4', N);

  const eventsPath = path.join(storageRoot, 'sessions', 'sess-24-4', 'events.ndjson');
  const { appendFile } = await import('node:fs/promises');
  await appendFile(eventsPath, `{"seq":${N + 1},"sessionId":"sess-24-4","torn`);
  const beforeRead = await readFile(eventsPath, 'utf8');

  const collected: Envelope[] = [];
  for await (const result of store.readEventsAfter(record.id, (N - 5) as never)) {
    assert.equal(result.ok, true);
    if (result.ok) collected.push(result.value);
  }
  assert.deepEqual(collected.map((e) => e.seq), [N - 4, N - 3, N - 2, N - 1, N], 'the torn trailing line is dropped, the preceding lines are served');

  const afterRead = await readFile(eventsPath, 'utf8');
  assert.equal(afterRead, beforeRead, 'a read must not modify the spill file');
});

test('S3.5 — an empty ring cannot serve any range, including after: 0, so replay falls through to the spill', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const config = baseConfig(storageRoot);
  // `ringCapacity: 0` is a legal configuration and makes `pushRing` a no-op, which is the
  // cheapest way to reach the state a rehydrated session is also in.
  const off: Config = { ...config, caps: { ...config.caps, ringCapacity: 0 } };
  const storeResult = await createStore(off);
  if (!storeResult.ok) return;
  const store = storeResult.value;
  const record = sessionRecord('sess-8');
  await store.createSession(record);

  for (let seq = 1; seq <= 5; seq++) {
    const e = envelope('sess-8', seq);
    store.pushRing(record.id, e);
    await store.appendEvent(record.id, e);
  }

  // `[]` here would be the ring claiming to have served the whole history it never held,
  // which is a blank transcript for a session whose events are all on disk.
  assert.equal(store.readRingAfter(record.id, 0 as never), null, 'an empty ring cannot answer after: 0');
  assert.equal(store.readRingAfter(record.id, 3 as never), null, 'nor any later range');

  const spilled: Envelope[] = [];
  for await (const result of store.readEventsAfter(record.id, 0 as never)) {
    if (result.ok) spilled.push(result.value);
  }
  assert.deepEqual(spilled.map((e) => e.seq), [1, 2, 3, 4, 5], 'and the spill still holds all of it');
});

// ---------------------------------------------------------------------------
// S12 — readAuditPage
// ---------------------------------------------------------------------------

function emptyAuditQuery(overrides: Partial<import('../contract/index.js').AuditQuery> = {}): import('../contract/index.js').AuditQuery {
  return {
    before: null,
    limit: 200,
    sessionId: null,
    operator: null,
    since: null,
    until: null,
    incidentsOnly: false,
    ...overrides,
  };
}

test('S12.2 — records come back newest first, and nextCursor is null exactly when the window reached the oldest record', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const storeResult = await createStore(baseConfig(storageRoot));
  if (!storeResult.ok) return;
  const store = storeResult.value;

  const records = Array.from({ length: 5 }, (_, i) => auditRecord(i + 1));
  await writeAuditFixture(storageRoot, records);

  const page = await store.readAuditPage(emptyAuditQuery({ limit: 10 }));
  assert.equal(page.ok, true);
  if (!page.ok) return;
  assert.deepEqual(page.value.records.map((r) => r.input.seq), [5, 4, 3, 2, 1], 'newest first');
  assert.equal(page.value.nextCursor, null, 'the whole file fit in one page — the oldest record was reached');
});

test('S12.3 — a limit above caps.auditPageMax is clamped, not refused, over a log at least 3x the cap', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const config = baseConfig(storageRoot);
  const capped: Config = { ...config, caps: { ...config.caps, auditPageMax: 40 } };
  const storeResult = await createStore(capped);
  if (!storeResult.ok) return;
  const store = storeResult.value;

  const N = 130; // > 3x auditPageMax (40)
  const records = Array.from({ length: N }, (_, i) => auditRecord(i + 1));
  await writeAuditFixture(storageRoot, records);

  const page = await store.readAuditPage(emptyAuditQuery({ limit: 10_000 }));
  assert.equal(page.ok, true);
  if (!page.ok) return;
  assert.equal(page.value.records.length, 40, 'clamped to auditPageMax rather than refused');
  assert.notEqual(page.value.nextCursor, null);
});

test('S12.4 — paging by nextCursor visits every record exactly once: concatenated pages equal the file read newest-first, over 500+ records', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const config = baseConfig(storageRoot);
  const capped: Config = { ...config, caps: { ...config.caps, auditPageMax: 37 } }; // deliberately not a divisor of N
  const storeResult = await createStore(capped);
  if (!storeResult.ok) return;
  const store = storeResult.value;

  const N = 517;
  const records = Array.from({ length: N }, (_, i) => auditRecord(i + 1));
  await writeAuditFixture(storageRoot, records);

  const visited: number[] = [];
  let before: AuditCursor | null = null;
  let pages = 0;
  for (;;) {
    const page = await store.readAuditPage(emptyAuditQuery({ before, limit: 37 }));
    assert.equal(page.ok, true);
    if (!page.ok) return;
    pages += 1;
    assert.ok(pages < 100, 'paging did not converge — likely an infinite loop');
    for (const r of page.value.records) visited.push(r.input.seq as number);
    if (page.value.nextCursor === null) break;
    before = page.value.nextCursor;
  }

  const expected = records.map((r) => r.input.seq as number).reverse(); // newest first
  assert.deepEqual(visited, expected, 'no duplicate, no omission, across every page');
});

test('S12.5 — the cursor is opaque and server-minted: an altered cursor is refused rather than followed', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const storeResult = await createStore(baseConfig(storageRoot));
  if (!storeResult.ok) return;
  const store = storeResult.value;

  const records = Array.from({ length: 5 }, (_, i) => auditRecord(i + 1));
  await writeAuditFixture(storageRoot, records);

  const page = await store.readAuditPage(emptyAuditQuery({ limit: 2 }));
  assert.equal(page.ok, true);
  if (!page.ok) return;
  assert.notEqual(page.value.nextCursor, null);
  const realCursor = page.value.nextCursor!;

  // Flip a character in the middle of the opaque token — anywhere in the base64url
  // payload invalidates either the encoded offset or the HMAC over it.
  const chars = realCursor.split('');
  const mid = Math.floor(chars.length / 2);
  chars[mid] = chars[mid] === 'a' ? 'b' : 'a';
  const tampered = chars.join('') as AuditCursor;

  const refused = await store.readAuditPage(emptyAuditQuery({ before: tampered, limit: 2 }));
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.error.code, 'corrupt');

  // The real cursor still works — only the altered one is refused.
  const stillWorks = await store.readAuditPage(emptyAuditQuery({ before: realCursor, limit: 2 }));
  assert.equal(stillWorks.ok, true);
});

test('S12.5 — a tampered cursor is refused even when audit.ndjson does not exist yet', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const storeResult = await createStore(baseConfig(storageRoot));
  if (!storeResult.ok) return;
  const store = storeResult.value;

  // No writeAuditFixture call — audit.ndjson is never created.
  const refused = await store.readAuditPage(emptyAuditQuery({ before: 'not-a-real-cursor' as AuditCursor, limit: 2 }));
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.error.code, 'corrupt', 'a tampered cursor must not be silently accepted just because the file is missing');
});

test('S12.6 — sessionId, operator, since and until each narrow the window, and combine', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const storeResult = await createStore(baseConfig(storageRoot));
  if (!storeResult.ok) return;
  const store = storeResult.value;

  const records = [
    auditRecord(1, { sessionId: 's-a' as never, operator: 'op-a' as never, ts: '2026-01-01T00:00:01.000Z' as never }),
    auditRecord(2, { sessionId: 's-a' as never, operator: 'op-b' as never, ts: '2026-01-01T00:00:02.000Z' as never }),
    auditRecord(3, { sessionId: 's-b' as never, operator: 'op-a' as never, ts: '2026-01-01T00:00:03.000Z' as never }),
    auditRecord(4, { sessionId: 's-b' as never, operator: 'op-b' as never, ts: '2026-01-01T00:00:04.000Z' as never }),
  ];
  await writeAuditFixture(storageRoot, records);

  const bySession = await store.readAuditPage(emptyAuditQuery({ sessionId: 's-a' as never, limit: 10 }));
  assert.equal(bySession.ok, true);
  if (bySession.ok) assert.deepEqual(bySession.value.records.map((r) => r.input.seq), [2, 1]);

  const byOperator = await store.readAuditPage(emptyAuditQuery({ operator: 'op-b' as never, limit: 10 }));
  assert.equal(byOperator.ok, true);
  if (byOperator.ok) assert.deepEqual(byOperator.value.records.map((r) => r.input.seq), [4, 2]);

  const bySince = await store.readAuditPage(emptyAuditQuery({ since: '2026-01-01T00:00:03.000Z' as never, limit: 10 }));
  assert.equal(bySince.ok, true);
  if (bySince.ok) assert.deepEqual(bySince.value.records.map((r) => r.input.seq), [4, 3]);

  const byUntil = await store.readAuditPage(emptyAuditQuery({ until: '2026-01-01T00:00:02.000Z' as never, limit: 10 }));
  assert.equal(byUntil.ok, true);
  if (byUntil.ok) assert.deepEqual(byUntil.value.records.map((r) => r.input.seq), [2, 1]);

  // Combined: session s-a AND operator op-b — only record 2.
  const combined = await store.readAuditPage(emptyAuditQuery({ sessionId: 's-a' as never, operator: 'op-b' as never, limit: 10 }));
  assert.equal(combined.ok, true);
  if (combined.ok) assert.deepEqual(combined.value.records.map((r) => r.input.seq), [2]);
});

test('D131 — a filtered read is bounded by caps.auditPageMax records examined, not only records returned', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const config = baseConfig(storageRoot);
  const capped: Config = { ...config, caps: { ...config.caps, auditPageMax: 40 } };
  const storeResult = await createStore(capped);
  if (!storeResult.ok) return;
  const store = storeResult.value;

  // 400 records, of which exactly two — the two oldest — match the filter. Reading by
  // result count alone would answer this in one call by walking to byte 0; reading by
  // records examined must take at least ceil(400 / 40) = 10 pages to reach them.
  const N = 400;
  const records = Array.from({ length: N }, (_, i) =>
    auditRecord(i + 1, { sessionId: (i < 2 ? 's-wanted' : 's-other') as never }),
  );
  await writeAuditFixture(storageRoot, records);

  const first = await store.readAuditPage(emptyAuditQuery({ sessionId: 's-wanted' as never, limit: 40 }));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.value.records, [], 'the newest 40 records hold no match');
  assert.notEqual(first.value.nextCursor, null, 'a short page is not the end of the log — the cursor says where to resume');

  let before = first.value.nextCursor;
  let pages = 1;
  const seen: number[] = [];
  while (before !== null) {
    const page = await store.readAuditPage(emptyAuditQuery({ before, sessionId: 's-wanted' as never, limit: 40 }));
    assert.equal(page.ok, true);
    if (!page.ok) return;
    pages += 1;
    for (const r of page.value.records) seen.push(r.input.seq as number);
    before = page.value.nextCursor;
    assert.ok(pages <= N, 'paging must terminate');
  }

  assert.deepEqual(seen, [2, 1], 'every match is visited exactly once, newest first, across the paging');
  assert.ok(pages >= N / capped.caps.auditPageMax, `a bounded read needs at least ${N / capped.caps.auditPageMax} pages, took ${pages}`);
});

test('S12.8 — a record for a session removed by deleteSession is still readable, with vendor and sandbox intact', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const storeResult = await createStore(baseConfig(storageRoot));
  if (!storeResult.ok) return;
  const store = storeResult.value;

  const record = sessionRecord('sess-removed');
  await store.createSession(record);
  const audit = auditRecord(1, { sessionId: 'sess-removed' as never, vendor: 'codex', sandbox: 'workspace-write' as never });
  await writeAuditFixture(storageRoot, [audit]);

  const removed = await store.deleteSession(record.id);
  assert.equal(removed.ok, true);

  const page = await store.readAuditPage(emptyAuditQuery({ limit: 10 }));
  assert.equal(page.ok, true);
  if (!page.ok) return;
  assert.equal(page.value.records.length, 1);
  assert.equal(page.value.records[0]!.sessionId, 'sess-removed');
  assert.equal(page.value.records[0]!.vendor, 'codex');
  assert.equal(page.value.records[0]!.sandbox, 'workspace-write');
});

// ---------------------------------------------------------------------------
// S17 — incidentsOnly
// ---------------------------------------------------------------------------

test('S17.1 — incidentsOnly returns exactly the union of decision===deny, operator===null and scope===standing, and nothing else', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const storeResult = await createStore(baseConfig(storageRoot));
  if (!storeResult.ok) return;
  const store = storeResult.value;

  // Every dimension isolated, plus two records that straddle two sets at once, so the
  // union is exercised rather than three independently-correct single-dimension checks.
  const ordinary = [
    auditRecord(1, { operator: 'op-1' as never, decision: 'allow', scope: 'once' }),
    auditRecord(2, { operator: 'op-2' as never, decision: 'allow', scope: 'once' }),
  ];
  const denyOnly = [
    auditRecord(3, { operator: 'op-1' as never, decision: 'deny', scope: 'once' }),
    auditRecord(4, { operator: 'op-2' as never, decision: 'deny', scope: 'once' }),
  ];
  const operatorNullOnly = [
    auditRecord(5, { operator: null, decision: 'allow', scope: 'once' }),
    auditRecord(6, { operator: null, decision: 'allow', scope: 'once' }),
  ];
  const standingOnly = [
    auditRecord(7, { operator: 'op-3' as never, decision: 'allow', scope: 'standing' as never }),
    auditRecord(8, { operator: 'op-4' as never, decision: 'allow', scope: 'standing' as never }),
  ];
  const denyAndOperatorNull = [auditRecord(9, { operator: null, decision: 'deny', scope: 'once' })];
  const operatorNullAndStanding = [auditRecord(10, { operator: null, decision: 'allow', scope: 'standing' as never })];

  const records = [...ordinary, ...denyOnly, ...operatorNullOnly, ...standingOnly, ...denyAndOperatorNull, ...operatorNullAndStanding];
  await writeAuditFixture(storageRoot, records);

  const denyCount = records.filter((r) => r.decision === 'deny').length;
  const operatorNullCount = records.filter((r) => r.operator === null).length;
  const standingCount = records.filter((r) => r.scope === 'standing').length;
  assert.equal(denyCount, 3, 'deny set: 3, 4, 9');
  assert.equal(operatorNullCount, 4, 'operator===null set: 5, 6, 9, 10');
  assert.equal(standingCount, 3, 'standing set: 7, 8, 10');

  const page = await store.readAuditPage(emptyAuditQuery({ incidentsOnly: true, limit: 200 }));
  assert.equal(page.ok, true);
  if (!page.ok) return;
  const gotSeqs = new Set(page.value.records.map((r) => r.input.seq as number));
  assert.equal(gotSeqs.size, 8, 'the union is 8 records — 10 minus the 2 ordinary ones');
  assert.deepEqual(gotSeqs, new Set([3, 4, 5, 6, 7, 8, 9, 10]), 'exactly the union and nothing else');
  assert.ok(!gotSeqs.has(1) && !gotSeqs.has(2), 'ordinary allows are excluded');
});

test('S17.2 — paging by nextCursor with incidentsOnly:true visits every incident exactly once, no duplicate, no omission, over 500+ records', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const config = baseConfig(storageRoot);
  const capped: Config = { ...config, caps: { ...config.caps, auditPageMax: 37 } }; // deliberately not a divisor of N
  const storeResult = await createStore(capped);
  if (!storeResult.ok) return;
  const store = storeResult.value;

  const N = 517;
  // Every third record is a forced (operator: null) incident; the rest are ordinary.
  const records = Array.from({ length: N }, (_, i) =>
    auditRecord(i + 1, (i + 1) % 3 === 0 ? { operator: null } : {}),
  );
  await writeAuditFixture(storageRoot, records);

  const visited: number[] = [];
  let before: AuditCursor | null = null;
  let pages = 0;
  for (;;) {
    const page = await store.readAuditPage(emptyAuditQuery({ before, limit: 37, incidentsOnly: true }));
    assert.equal(page.ok, true);
    if (!page.ok) return;
    pages += 1;
    assert.ok(pages < 100, 'paging did not converge — likely an infinite loop');
    for (const r of page.value.records) visited.push(r.input.seq as number);
    if (page.value.nextCursor === null) break;
    before = page.value.nextCursor;
  }

  const expected = records
    .filter((r) => r.operator === null)
    .map((r) => r.input.seq as number)
    .reverse(); // newest first
  assert.ok(expected.length > 100, 'the fixture has enough incidents to span several pages');
  assert.deepEqual(visited, expected, 'no duplicate, no omission, across every page — same clamping, cursor and paging as S12.4');
});

test('S17.6 — incidentsOnly reads records for a session removed by deleteSession, alongside a live one owned by a different operator', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const storeResult = await createStore(baseConfig(storageRoot));
  if (!storeResult.ok) return;
  const store = storeResult.value;

  const removed = sessionRecord('sess-removed');
  await store.createSession(removed);
  const notOwned = auditRecord(1, { sessionId: 'sess-not-owned' as never, operator: null, decision: 'deny' });
  const forRemoved = auditRecord(2, { sessionId: 'sess-removed' as never, operator: null, decision: 'deny' });
  await writeAuditFixture(storageRoot, [notOwned, forRemoved]);

  const deleted = await store.deleteSession(removed.id);
  assert.equal(deleted.ok, true);

  const page = await store.readAuditPage(emptyAuditQuery({ incidentsOnly: true, limit: 10 }));
  assert.equal(page.ok, true);
  if (!page.ok) return;
  assert.equal(page.value.records.length, 2, 'both the deleted session\'s record and the not-owned one are read (D70, D25)');
});

test('S12.9 — no read scans the whole file: first-page elapsed time at 100,000 records is not far off first-page time at 10,000', async () => {
  const storageRoot10k = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const storeResult10k = await createStore(baseConfig(storageRoot10k));
  if (!storeResult10k.ok) return;
  const store10k = storeResult10k.value;
  await writeAuditFixture(storageRoot10k, Array.from({ length: 10_000 }, (_, i) => auditRecord(i + 1)));

  const storageRoot100k = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const storeResult100k = await createStore(baseConfig(storageRoot100k));
  if (!storeResult100k.ok) return;
  const store100k = storeResult100k.value;
  await writeAuditFixture(storageRoot100k, Array.from({ length: 100_000 }, (_, i) => auditRecord(i + 1)));

  const start10k = performance.now();
  const first10k = await store10k.readAuditPage(emptyAuditQuery({ limit: 50 }));
  const elapsed10k = performance.now() - start10k;
  assert.equal(first10k.ok, true);

  const start100k = performance.now();
  const first100k = await store100k.readAuditPage(emptyAuditQuery({ limit: 50 }));
  const elapsed100k = performance.now() - start100k;
  assert.equal(first100k.ok, true);

  // Also page all the way back to the oldest record in the 10k log, to report the
  // "deepest page" figure S12.9 asks for.
  let before: AuditCursor | null = null;
  let deepestElapsed = 0;
  for (;;) {
    const start = performance.now();
    const page = await store10k.readAuditPage(emptyAuditQuery({ before, limit: 50 }));
    deepestElapsed = performance.now() - start;
    assert.equal(page.ok, true);
    if (!page.ok) return;
    if (page.value.nextCursor === null) break;
    before = page.value.nextCursor;
  }

  console.log(
    `[S12.9] first page: 10k records ${elapsed10k.toFixed(2)}ms, 100k records ${elapsed100k.toFixed(2)}ms; deepest page (10k log): ${deepestElapsed.toFixed(2)}ms`,
  );
  // A whole-file scan would make the 100k-record first page roughly 10x the 10k one; a
  // bounded read stays close regardless of file size. Generous factor to keep this from
  // being timing-flaky while still catching an accidental full scan.
  assert.ok(elapsed100k < elapsed10k * 5 + 50, `first-page time grew with file size: 10k=${elapsed10k}ms, 100k=${elapsed100k}ms`);
});

// D194: the module constant `claimLock` waits on. Not exported (only the interval is,
// I62) — tests rely on the literal value the contract fixes it at.
const LOCK_OBSERVATION_WINDOW_MS = 10_000;

function lock(overrides: Partial<ServerLock> = {}): ServerLock {
  return {
    instanceId: randomUUID(),
    renewals: 0,
    pid: 4242,
    hostname: 'holder-host',
    startedAt: new Date().toISOString() as never,
    image: 'node',
    ...overrides,
  };
}

async function newStore(): Promise<{ storageRoot: string; store: Store }> {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const storeResult = await createStore(baseConfig(storageRoot));
  assert.equal(storeResult.ok, true);
  if (!storeResult.ok) throw new Error('store failed to init');
  return { storageRoot, store: storeResult.value };
}

// D180's decision table, row 1: absent → write `self`, claimed with no wait.
test('S30.1a — claimLock against an absent server.lock writes self and claims immediately', async () => {
  const { storageRoot, store } = await newStore();
  const self = lock({ pid: process.pid, hostname: 'self-host' });
  const t0 = Date.now();
  const claimed = await store.claimLock(self);
  assert.equal(claimed.ok, true);
  assert.ok(Date.now() - t0 < 1000, 'an absent lock claims well under one observation window');

  const raw = await readFile(path.join(storageRoot, 'server.lock'), 'utf8');
  assert.deepEqual(JSON.parse(raw), self);
});

// D180's decision table, row 2: present, unparseable → refuse storage_lock_corrupt. This is
// corruption, not a race (I61), so it is refused without waiting out the window.
test('S30.1b — a server.lock that will not parse refuses storage_lock_corrupt, naming the path, with no wait', async () => {
  const { storageRoot, store } = await newStore();
  await writeFile(path.join(storageRoot, 'server.lock'), 'not json at all');

  const filePath = path.join(storageRoot, 'server.lock');
  const t0 = Date.now();
  const claimed = await store.claimLock(lock({ pid: process.pid }));
  assert.ok(Date.now() - t0 < 1000, 'corruption is detected without waiting out the observation window');
  assert.equal(claimed.ok, false);
  if (!claimed.ok) {
    assert.equal(claimed.error.code, 'storage_lock_corrupt');
    if (claimed.error.code === 'storage_lock_corrupt') assert.equal(claimed.error.path, filePath);
  }

  const raw = await readFile(filePath, 'utf8');
  assert.equal(raw, 'not json at all', 'the lock file is untouched by a refused claim');
});

// D180's decision table, row 3: present, (instanceId, renewals) changed across the window →
// refuse storage_locked, naming the holder's informational fields.
test('S30.1c — a lock whose (instanceId, renewals) changes across the window refuses storage_locked, naming pid, hostname and startedAt', async () => {
  const { storageRoot, store } = await newStore();
  const filePath = path.join(storageRoot, 'server.lock');
  const holder = lock({ pid: 777, hostname: 'holder-host', startedAt: '2026-01-01T00:00:00.000Z' as never, renewals: 0 });
  await writeFile(filePath, JSON.stringify(holder));
  // A renewal partway through the window: the holder is alive and renewing.
  const renewedHolder = { ...holder, renewals: 1 };
  const renewTimer = setTimeout(() => writeFile(filePath, JSON.stringify(renewedHolder)), LOCK_OBSERVATION_WINDOW_MS / 3);

  const claimed = await store.claimLock(lock({ pid: process.pid }));
  clearTimeout(renewTimer);
  assert.equal(claimed.ok, false);
  if (!claimed.ok) {
    assert.equal(claimed.error.code, 'storage_locked');
    if (claimed.error.code === 'storage_locked') {
      assert.equal(claimed.error.holder.pid, 777);
      assert.equal(claimed.error.holder.hostname, 'holder-host');
      assert.equal(claimed.error.holder.startedAt, '2026-01-01T00:00:00.000Z');
    }
  }
});

// D180's decision table, row 4: present, (instanceId, renewals) unchanged across the window
// → reclaim: log the holder, overwrite with self, claimed.
test('S30.1d — a lock whose (instanceId, renewals) is unchanged across the window is reclaimed, logged, and self takes it', async () => {
  const { storageRoot, store } = await newStore();
  const filePath = path.join(storageRoot, 'server.lock');
  const holder = lock({ pid: 555, hostname: 'holder-host' });
  await writeFile(filePath, JSON.stringify(holder));

  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
  let claimed;
  try {
    claimed = await store.claimLock(lock({ pid: process.pid }));
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(claimed.ok, true);
  assert.ok(
    warnings.some((w) => w.includes('555') && w.includes('holder-host')),
    `expected a reclaim log naming the stale holder; got: ${JSON.stringify(warnings)}`,
  );

  const raw = await readFile(filePath, 'utf8');
  assert.equal(JSON.parse(raw).pid, process.pid, 'self now holds the lock');
});

// S30.2: the criterion the slice exists for (#206) — a lock naming a different hostname,
// with an unmoving counter, is reclaimed and boot proceeds. The holding host is deleted from
// the decision entirely (D180); a hostname mismatch is an ordinary, expected observation.
test('S30.2 — a lock naming a different hostname whose counter is not moving is reclaimed, and boot proceeds', async () => {
  const { storageRoot, store } = await newStore();
  const filePath = path.join(storageRoot, 'server.lock');
  const holder = lock({ pid: 42, hostname: 'a-different-container' });
  await writeFile(filePath, JSON.stringify(holder));

  const claimed = await store.claimLock(lock({ pid: process.pid, hostname: 'this-container' }));
  assert.equal(claimed.ok, true);
  const raw = await readFile(filePath, 'utf8');
  assert.equal(JSON.parse(raw).pid, process.pid);
});

// S30.3: a lock written before the lease — well-formed, carrying no counter — reaches the
// reclaim path by the ordinary rule and is not treated as corruption (I61).
test('S30.3 — a legacy lock with no instanceId/renewals is not corruption and reclaims by the ordinary rule', async () => {
  const { storageRoot, store } = await newStore();
  const filePath = path.join(storageRoot, 'server.lock');
  const legacyHolder = { pid: 88, hostname: 'holder-host', startedAt: new Date().toISOString(), image: 'node' };
  await writeFile(filePath, JSON.stringify(legacyHolder));

  const claimed = await store.claimLock(lock({ pid: process.pid }));
  assert.equal(claimed.ok, true, 'a legacy lock reclaims rather than refusing storage_lock_corrupt');
  const raw = await readFile(filePath, 'utf8');
  assert.equal(JSON.parse(raw).pid, process.pid);
});

// S30.4: no wall clock is compared anywhere in the decision — stepping the system clock
// during the observation window must not change either outcome.
test('S30.4 — no wall clock is compared: stepping the system clock during the window leaves both decisions unchanged', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const { storageRoot, store } = await newStore();
    const filePath = path.join(storageRoot, 'server.lock');

    // Backwards, during a window that ends in reclaim (counter never moves).
    await writeFile(filePath, JSON.stringify(lock({ pid: 1 })));
    const backwards = store.claimLock(lock({ pid: process.pid }));
    t.mock.timers.setTime(Date.now() - 3600_000);
    const reclaimed = await backwards;
    assert.equal(reclaimed.ok, true, 'reclaimed despite the wall clock jumping backwards');

    // Forwards, during a window that ends in refusal (counter moves).
    const holder = lock({ pid: 2, renewals: 0 });
    await writeFile(filePath, JSON.stringify(holder));
    setTimeout(() => writeFile(filePath, JSON.stringify({ ...holder, renewals: 1 })), LOCK_OBSERVATION_WINDOW_MS / 3);
    const forwards = store.claimLock(lock({ pid: process.pid }));
    t.mock.timers.setTime(Date.now() + 3600_000);
    const refused = await forwards;
    assert.equal(refused.ok, false, 'still refused despite the wall clock jumping forwards');
  } finally {
    t.mock.timers.reset();
  }
});

// S30.5: a live holder — one whose counter keeps moving — is never declared dead, across
// three separate boots each independently observing it.
test('S30.5 — a live holder is never declared dead across three consecutive boots each observing the counter move', async () => {
  const { storageRoot, store } = await newStore();
  const filePath = path.join(storageRoot, 'server.lock');
  let renewals = 0;
  const renew = () => writeFile(filePath, JSON.stringify(lock({ pid: 333, renewals: renewals++ })));
  await renew();
  const renewer = setInterval(renew, LOCK_RENEWAL_INTERVAL_MS);
  try {
    for (let i = 0; i < 3; i++) {
      const claimed = await store.claimLock(lock({ pid: process.pid }));
      assert.equal(claimed.ok, false, `boot ${i + 1} must not declare a renewing holder dead`);
    }
  } finally {
    clearInterval(renewer);
  }
});

// S30.6: the interval stays comfortably below the window — declared together (I62) so a
// violation is caught here rather than discovered as two servers over one storage root.
test('S30.6 — LOCK_RENEWAL_INTERVAL_MS stays at most a third of LOCK_OBSERVATION_WINDOW_MS', () => {
  assert.ok(
    LOCK_RENEWAL_INTERVAL_MS * 3 <= LOCK_OBSERVATION_WINDOW_MS,
    `interval ${LOCK_RENEWAL_INTERVAL_MS}ms must leave room for at least 3 renewals inside the ${LOCK_OBSERVATION_WINDOW_MS}ms window`,
  );
});

// S30.7: two boots racing one absent lock cannot both make the "absent" observation and
// both write via the exclusive create — exactly one wins it immediately, and the other
// necessarily falls back to the reclaim path (and, since nothing renews here, reclaims too).
test('S30.7 — two boots racing an absent lock: exactly one claims immediately, the other pays the reclaim path', async () => {
  const { store } = await newStore();
  const t0 = Date.now();
  const [a, b] = await Promise.all([
    store.claimLock(lock({ pid: 1 })).then((r) => ({ r, ms: Date.now() - t0 })),
    store.claimLock(lock({ pid: 2 })).then((r) => ({ r, ms: Date.now() - t0 })),
  ]);
  const immediate = [a, b].filter((x) => x.ms < 1000);
  const delayed = [a, b].filter((x) => x.ms >= 1000);
  assert.equal(immediate.length, 1, 'exactly one boot claims the absent lock without waiting');
  assert.equal(delayed.length, 1, 'the other observes a present lock and pays the observation window');
  assert.equal(a.r.ok, true);
  assert.equal(b.r.ok, true);
});

// S30.8/I56: release is an ownership check. A server whose lock was reclaimed and rewritten
// by a successor removes nothing at shutdown.
test('S30.8 — releaseLock is a no-op once the lock names a successor, and removes nothing of theirs', async () => {
  const { storageRoot, store } = await newStore();
  const filePath = path.join(storageRoot, 'server.lock');
  assert.equal((await store.claimLock(lock({ pid: process.pid }))).ok, true);

  const successor = lock({ pid: 999, hostname: 'other-host' });
  await writeFile(filePath, JSON.stringify(successor));

  const released = await store.releaseLock();
  assert.equal(released.ok, true);
  const raw = await readFile(filePath, 'utf8');
  assert.deepEqual(JSON.parse(raw), successor, "the successor's claim is untouched");
});

// S22.5 (re-run unchanged per S30.13): a clean shutdown removes the lock, and the next claim
// against the now-absent lock takes it immediately, without paying the observation window.
test('S22.5 — releaseLock removes the lock; the next claim against the absent lock claims with no wait', async () => {
  const { storageRoot, store } = await newStore();
  const self = lock({ pid: process.pid, hostname: 'self-host' });
  assert.equal((await store.claimLock(self)).ok, true);

  const released = await store.releaseLock();
  assert.equal(released.ok, true);
  await assert.rejects(readFile(path.join(storageRoot, 'server.lock'), 'utf8'), /ENOENT/);

  const t0 = Date.now();
  const claimed = await store.claimLock(self);
  assert.equal(claimed.ok, true);
  assert.ok(Date.now() - t0 < 1000, 'no staleness path invoked: the reclaim is immediate on an absent lock');
});

// releaseLock on an already-absent lock, or one this process never claimed, is not an error.
test('S30.8b — releaseLock is a no-op, not an error, when there is no lock to remove or none was ever claimed', async () => {
  const { store } = await newStore();
  const released = await store.releaseLock();
  assert.equal(released.ok, true);
});

// S30.9: renewLock reports 'displaced' — a success — on an absent lock and on one naming
// another instance, and a storage error only when the renewal itself could not be attempted.
test('S30.9a — renewLock reports displaced when the lock is absent', async () => {
  const { storageRoot, store } = await newStore();
  assert.equal((await store.claimLock(lock({ pid: process.pid }))).ok, true);
  await rm(path.join(storageRoot, 'server.lock'), { force: true });

  const renewed = await store.renewLock();
  assert.equal(renewed.ok, true);
  if (renewed.ok) assert.equal(renewed.value, 'displaced');
});

test('S30.9b — renewLock reports displaced when the lock names another instance', async () => {
  const { storageRoot, store } = await newStore();
  const filePath = path.join(storageRoot, 'server.lock');
  assert.equal((await store.claimLock(lock({ pid: process.pid }))).ok, true);
  await writeFile(filePath, JSON.stringify(lock({ pid: 555 })));

  const renewed = await store.renewLock();
  assert.equal(renewed.ok, true);
  if (renewed.ok) assert.equal(renewed.value, 'displaced');
});

test('S30.9c — renewLock reports a storage error, not a displacement, when the renewal cannot be attempted at all', async () => {
  const { storageRoot, store } = await newStore();
  const filePath = path.join(storageRoot, 'server.lock');
  assert.equal((await store.claimLock(lock({ pid: process.pid }))).ok, true);
  // Replace the lock file with a directory of the same name: the read this renewal needs
  // fails outright, rather than observing an absent or foreign lock.
  await rm(filePath, { force: true });
  await mkdir(filePath);
  try {
    const renewed = await store.renewLock();
    assert.equal(renewed.ok, false);
    if (!renewed.ok) assert.equal(renewed.error.code, 'io');
  } finally {
    await rm(filePath, { recursive: true, force: true });
  }
});

// S30.12: no decision reads pid, hostname, startedAt or image (I57) — only (instanceId,
// renewals). Every informational field can change mid-window and the reclaim still happens.
test('S30.12 — the reclaim decision ignores pid, hostname, startedAt and image; only instanceId/renewals are compared', async () => {
  const { storageRoot, store } = await newStore();
  const filePath = path.join(storageRoot, 'server.lock');
  const instanceId = randomUUID();
  await writeFile(filePath, JSON.stringify(lock({ instanceId, renewals: 5, pid: 111, hostname: 'a', image: 'x' })));
  setTimeout(() => writeFile(filePath, JSON.stringify(lock({ instanceId, renewals: 5, pid: 222, hostname: 'b', image: 'y' }))), LOCK_OBSERVATION_WINDOW_MS / 3);

  const claimed = await store.claimLock(lock({ pid: process.pid }));
  assert.equal(claimed.ok, true, 'unchanged (instanceId, renewals) reclaims even though every informational field changed');
});

// S30.14: a refused boot has written nothing server-wide, on the corrupt-lock row as well as
// the held one (S22.7 already covers the held row via session-manager's own boot test).
test('S30.14 — a corrupt-lock refusal leaves every other server-wide file untouched', async () => {
  const { storageRoot, store } = await newStore();
  await writeFile(path.join(storageRoot, 'audit.ndjson'), 'unrelated line\n');
  await writeFile(path.join(storageRoot, 'server.lock'), 'not json');
  const before = await readFile(path.join(storageRoot, 'audit.ndjson'), 'utf8');

  const claimed = await store.claimLock(lock({ pid: process.pid }));
  assert.equal(claimed.ok, false);
  const after = await readFile(path.join(storageRoot, 'audit.ndjson'), 'utf8');
  assert.equal(after, before);
});

async function newStoreWithToolOutputCap(sessionToolOutputBytes: number): Promise<{ storageRoot: string; store: Store }> {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const config = baseConfig(storageRoot);
  const storeResult = await createStore({ ...config, caps: { ...config.caps, sessionToolOutputBytes } });
  assert.equal(storeResult.ok, true);
  if (!storeResult.ok) throw new Error('store failed to init');
  return { storageRoot, store: storeResult.value };
}

test('S23.1/S23.3 — many small blobs summing past the budget: earlier ones keep their bytes, the crossing one is not written', async () => {
  const { store } = await newStoreWithToolOutputCap(30);
  const record = sessionRecord('sess-s23-1');
  await store.createSession(record);

  const first = await store.writeToolOutput(record.id, 't1' as never, 'call-1' as never, Buffer.from('a'.repeat(15)));
  assert.equal(first.ok, true);
  const second = await store.writeToolOutput(record.id, 't1' as never, 'call-2' as never, Buffer.from('b'.repeat(15)));
  assert.equal(second.ok, true);
  // 15 + 15 = 30, at the budget; one more byte crosses it.
  const third = await store.writeToolOutput(record.id, 't1' as never, 'call-3' as never, Buffer.from('c'));
  assert.equal(third.ok, true, 'a budget-refused write is not an error');

  const openedFirst = await store.openToolOutput(record.id, 't1' as never, 'call-1' as never);
  assert.equal(openedFirst.ok, true, 'a blob written before the crossing stays fetchable');
  if (openedFirst.ok) {
    const chunks: Buffer[] = [];
    for await (const chunk of openedFirst.value) chunks.push(chunk as Buffer);
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'a'.repeat(15), 'byte-identical, not evicted');
  }
  const openedSecond = await store.openToolOutput(record.id, 't1' as never, 'call-2' as never);
  assert.equal(openedSecond.ok, true);

  const openedThird = await store.openToolOutput(record.id, 't1' as never, 'call-3' as never);
  assert.equal(openedThird.ok, false, 'S23.2: the refused blob was never written, so the fetch is not_found');
  if (!openedThird.ok) assert.equal(openedThird.error.code, 'not_found');
});

test('S23.4 — one large result crossing the budget alone is refused the same way', async () => {
  const { store } = await newStoreWithToolOutputCap(10);
  const record = sessionRecord('sess-s23-2');
  await store.createSession(record);

  const wrote = await store.writeToolOutput(record.id, 't1' as never, 'call-1' as never, Buffer.from('x'.repeat(11)));
  assert.equal(wrote.ok, true, 'a budget-refused write is not an error');
  const opened = await store.openToolOutput(record.id, 't1' as never, 'call-1' as never);
  assert.equal(opened.ok, false);
  if (!opened.ok) assert.equal(opened.error.code, 'not_found');
});

test('S23.5 — the tally is read off disk, not held in memory: a fresh store over the same storage root still refuses past the budget', async () => {
  const { storageRoot } = await newStoreWithToolOutputCap(20);
  const config = baseConfig(storageRoot);
  const cappedConfig = { ...config, caps: { ...config.caps, sessionToolOutputBytes: 20 } };
  const firstStoreResult = await createStore(cappedConfig);
  assert.equal(firstStoreResult.ok, true);
  if (!firstStoreResult.ok) return;
  const record = sessionRecord('sess-s23-3');
  await firstStoreResult.value.createSession(record);
  const wrote = await firstStoreResult.value.writeToolOutput(record.id, 't1' as never, 'call-1' as never, Buffer.from('y'.repeat(20)));
  assert.equal(wrote.ok, true);

  // A brand-new store instance over the same storage root, with no in-memory carryover.
  const secondStoreResult = await createStore(cappedConfig);
  assert.equal(secondStoreResult.ok, true);
  if (!secondStoreResult.ok) return;
  const refused = await secondStoreResult.value.writeToolOutput(record.id, 't1' as never, 'call-2' as never, Buffer.from('z'));
  assert.equal(refused.ok, true, 'a budget-refused write is not an error');
  const opened = await secondStoreResult.value.openToolOutput(record.id, 't1' as never, 'call-2' as never);
  assert.equal(opened.ok, false, 'the rehydrated tally already reflects the 20 bytes on disk');
});

test('S23.6 — attachments are not bounded by the tool-output budget', async () => {
  const { store } = await newStoreWithToolOutputCap(1);
  const record = sessionRecord('sess-s23-4');
  await store.createSession(record);

  // The tool-output budget is already exhausted...
  const wrote = await store.writeToolOutput(record.id, 't1' as never, 'call-1' as never, Buffer.from('xx'));
  assert.equal(wrote.ok, true);
  const opened = await store.openToolOutput(record.id, 't1' as never, 'call-1' as never);
  assert.equal(opened.ok, false, 'sanity: the tool-output budget did refuse the blob above');

  // ...but an attachment, an unrelated directory and cap, still writes normally.
  const attached = await store.writeAttachment(record.id, 't1' as never, 'att-1' as never, Buffer.from('hello'), 'text/plain');
  assert.equal(attached.ok, true);
  const openedAttachment = await store.openAttachment(record.id, 't1' as never, 'att-1' as never);
  assert.equal(openedAttachment.ok, true);
});

// D202: a `Store` owns OS handles (the four server-wide append files) and must be closed.
// Before this fix `close` had no declaration on `Store` at all, so a caller could not release
// them and this test failed to build.
test('D202 — Store.close() releases the server-wide append handles, writes nothing, and is idempotent', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const storeResult = await createStore(baseConfig(storageRoot));
  assert.equal(storeResult.ok, true);
  if (!storeResult.ok) return;
  const store = storeResult.value;

  // Open two of the four lazy handles (audit, pids) by appending through them; the other
  // two (reviews, requisitions) are deliberately left never-opened, exercising the case
  // `S7.10`/`S22.6` already rely on — closing must not require every handle to exist.
  const appended = await store.appendAudit(auditRecord(1));
  assert.equal(appended.ok, true);
  const appendedPid = await store.appendPid({
    pid: 4242,
    pgid: null,
    sessionId: 'sess-1' as never,
    turnId: 't1' as never,
    hostname: null,
    startedAt: new Date().toISOString() as never,
    image: 'node',
    osCreatedAt: null,
    exitedAt: null,
  });
  assert.equal(appendedPid.ok, true);

  const auditBefore = await readFile(path.join(storageRoot, 'audit.ndjson'), 'utf8');
  const pidsBefore = await readFile(path.join(storageRoot, 'pids.ndjson'), 'utf8');

  await assert.doesNotReject(store.close(), 'close resolves even with live handles open');
  await assert.doesNotReject(store.close(), 'a second close is a no-op, not a rejection');

  const auditAfter = await readFile(path.join(storageRoot, 'audit.ndjson'), 'utf8');
  const pidsAfter = await readFile(path.join(storageRoot, 'pids.ndjson'), 'utf8');
  assert.equal(auditAfter, auditBefore, 'close writes nothing to audit.ndjson');
  assert.equal(pidsAfter, pidsBefore, 'close writes nothing to pids.ndjson');
});

test('D202 — Store.close() is a no-op on a store that never opened any handle', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-store-'));
  const storeResult = await createStore(baseConfig(storageRoot));
  assert.equal(storeResult.ok, true);
  if (!storeResult.ok) return;

  await assert.doesNotReject(storeResult.value.close(), 'nothing was ever opened, so there is nothing to close');
});
