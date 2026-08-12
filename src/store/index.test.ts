import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createStore } from './index.js';
import type { AuditCursor, AuditRecord, Config, Envelope, SessionRecord } from '../contract/index.js';

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
      standingRuleBytes: 1024,
    },
    sessionCookieMaxAgeSeconds: 2592000,
    includeRaw: false,
    sessionTokenBudget: null,
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
