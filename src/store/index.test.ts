import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createStore } from './index.js';
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
      standingRuleBytes: 1024, attachmentBytes: 10485760, attachmentCount: 5,
    },
    sessionCookieMaxAgeSeconds: 2592000,
    includeRaw: false,
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

function lock(overrides: Partial<ServerLock> = {}): ServerLock {
  return {
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

// D161's decision table, row 1: absent → write `self`, claimed.
test('S22 — claimLock against an absent server.lock writes self and claims, without consulting the liveness probe', async () => {
  const { storageRoot, store } = await newStore();
  let probed = false;
  const self = lock({ pid: process.pid, hostname: 'self-host' });
  const claimed = await store.claimLock(self, async () => {
    probed = true;
    return true;
  });
  assert.equal(claimed.ok, true);
  assert.equal(probed, false, 'nothing to probe: there was no holder');

  const raw = await readFile(path.join(storageRoot, 'server.lock'), 'utf8');
  assert.deepEqual(JSON.parse(raw), self);
});

// D161's decision table, row 2 / I50: a lock naming a different host is never reclaimed,
// whatever its pid says — asserted with a probe that would say "live" if consulted, so a
// bug that skips the hostname check and reclaims anyway is caught by the probe having run.
test('S22.4 — a lock naming a different hostname always refuses, and the liveness probe is never consulted', async () => {
  const { storageRoot, store } = await newStore();
  const holder = lock({ hostname: 'other-host' });
  await writeFile(path.join(storageRoot, 'server.lock'), JSON.stringify(holder));

  let probed = false;
  const claimed = await store.claimLock(lock({ hostname: 'self-host' }), async () => {
    probed = true;
    return true; // if this were consulted, the wrong answer would let the claim through
  });
  assert.equal(claimed.ok, false);
  if (!claimed.ok) {
    assert.equal(claimed.error.code, 'storage_locked');
    if (claimed.error.code === 'storage_locked') assert.deepEqual(claimed.error.holder, holder);
  }
  assert.equal(probed, false, 'the liveness test cannot see another machine\'s process table');

  const raw = await readFile(path.join(storageRoot, 'server.lock'), 'utf8');
  assert.deepEqual(JSON.parse(raw), holder, 'the lock file is untouched by a refused claim');
});

// D161's decision table, row 3: present, this host, isLive true → refuse, naming the holder.
test('S22.1 — a live holder on this host refuses with storage_locked, naming pid, hostname and startedAt', async () => {
  const { storageRoot, store } = await newStore();
  const holder = lock({ pid: 777, hostname: 'self-host', startedAt: '2026-01-01T00:00:00.000Z' as never });
  await writeFile(path.join(storageRoot, 'server.lock'), JSON.stringify(holder));

  const claimed = await store.claimLock(lock({ hostname: 'self-host' }), async () => true);
  assert.equal(claimed.ok, false);
  if (!claimed.ok) {
    assert.equal(claimed.error.code, 'storage_locked');
    if (claimed.error.code === 'storage_locked') {
      assert.equal(claimed.error.holder.pid, 777);
      assert.equal(claimed.error.holder.hostname, 'self-host');
      assert.equal(claimed.error.holder.startedAt, '2026-01-01T00:00:00.000Z');
    }
  }
});

// D161's decision table, row 4 (S22.3): present, this host, isLive false → reclaim: the
// stale holder is logged, self is written, and the claim succeeds.
test('S22.3 — a stale holder on this host is reclaimed automatically, logged, and self takes the lock', async () => {
  const { storageRoot, store } = await newStore();
  const holder = lock({ pid: 555, hostname: 'self-host' });
  await writeFile(path.join(storageRoot, 'server.lock'), JSON.stringify(holder));

  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  let claimed;
  try {
    claimed = await store.claimLock(lock({ pid: process.pid, hostname: 'self-host' }), async () => false);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(claimed.ok, true);
  assert.ok(
    warnings.some((w) => w.includes('555') && w.includes('self-host')),
    `expected a reclaim log naming the stale holder; got: ${JSON.stringify(warnings)}`,
  );

  const raw = await readFile(path.join(storageRoot, 'server.lock'), 'utf8');
  assert.equal(JSON.parse(raw).pid, process.pid, 'self now holds the lock');
});

// D161's decision table, row 5: unparseable → treated as a stale holder and reclaimed,
// logged — refusing on it would make every unclean shutdown need manual intervention.
test('S22 — an unparseable server.lock is treated as a stale holder: reclaimed, logged, and boot proceeds', async () => {
  const { storageRoot, store } = await newStore();
  await writeFile(path.join(storageRoot, 'server.lock'), 'not json at all');

  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  let claimed;
  try {
    claimed = await store.claimLock(lock({ pid: process.pid, hostname: 'self-host' }), async () => {
      throw new Error('must not be consulted for an unparseable lock');
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(claimed.ok, true);
  assert.ok(warnings.some((w) => w.toLowerCase().includes('unparseable') || w.toLowerCase().includes('reclaim')));

  const raw = await readFile(path.join(storageRoot, 'server.lock'), 'utf8');
  assert.equal(JSON.parse(raw).pid, process.pid);
});

// S22.5: a clean shutdown removes the lock, and the next boot takes it without invoking
// the staleness path at all.
test('S22.5 — releaseLock removes the lock; the next claim against an absent lock never consults the liveness probe', async () => {
  const { storageRoot, store } = await newStore();
  const self = lock({ pid: process.pid, hostname: 'self-host' });
  assert.equal((await store.claimLock(self, async () => true)).ok, true);

  const released = await store.releaseLock();
  assert.equal(released.ok, true);
  await assert.rejects(readFile(path.join(storageRoot, 'server.lock'), 'utf8'), /ENOENT/);

  let probed = false;
  const claimed = await store.claimLock(self, async () => {
    probed = true;
    return false;
  });
  assert.equal(claimed.ok, true);
  assert.equal(probed, false, 'no holder to test the staleness of');
});

// releaseLock on an already-absent lock is not an error — a repeat clean shutdown, or a
// process that never claimed, must not fail here.
test('S22.5 — releaseLock is a no-op, not an error, when there is no lock to remove', async () => {
  const { store } = await newStore();
  const released = await store.releaseLock();
  assert.equal(released.ok, true);
});
