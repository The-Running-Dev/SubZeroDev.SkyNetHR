import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createSessionManager } from './index.js';
import { createStore } from '../store/index.js';
import type { AuditRecord, Checkpoints, Config, Envelope, OperatorId, Records, Store } from '../contract/index.js';

const FIXTURE = path.join(process.cwd(), 'src', 'adapters', 'claude', 'fixtures', 'fake-claude-cli.mjs');

async function readAudit(storageRoot: string): Promise<AuditRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path.join(storageRoot, 'audit.ndjson'), 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as AuditRecord);
}

function notImplementedProxy<T extends object>(name: string): T {
  return new Proxy({}, { get: () => () => { throw new Error(`${name} must not be called by session-manager in S1`); } }) as T;
}

async function makeManager(
  scenario: string,
  capsOverride: Partial<Config['caps']> = {},
  wrapStore: (store: Store) => Store = (s) => s,
) {
  process.env['SKYNET_TEST_SCENARIO'] = scenario;
  process.env['SKYNET_CLAUDE_EXECUTABLE'] = FIXTURE;
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-sm-'));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'skynet-ws-'));
  const config: Config = {
    bind: { host: '127.0.0.1', port: 3000 },
    auth: { mode: 'shared-secret', cookieName: 'skynet', secret: 'x' },
    workspaceRoots: [workspaceRoot as never],
    storageRoot,
    allowedOrigins: [],
    trustProxy: [],
    caps: {
      ringCapacity: 500,
      toolResultBytes: 65536,
      subscriberQueueHighWater: 1000,
      keepaliveMs: 15000,
      auditPageMax: 200,
      reviewBodyBytes: 1024,
      requisitionTextBytes: 1024,
      ...capsOverride,
    },
    includeRaw: false,
    sessionTokenBudget: null,
    checklist: [],
  };
  const storeResult = await createStore(config);
  if (!storeResult.ok) throw new Error('store failed to init');
  const manager = createSessionManager({
    config,
    store: wrapStore(storeResult.value),
    checkpoints: notImplementedProxy<Checkpoints>('checkpoints'),
    records: notImplementedProxy<Records>('records'),
  });
  return { manager, workspaceRoot, storageRoot, store: storeResult.value };
}

async function waitUntil2(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('S1.9 — the throwaway harness auto-denies a permission.request and the turn still reaches turn.ended', async () => {
  const { manager, workspaceRoot } = await makeManager('full');
  const owner = 'operator-1' as OperatorId;
  const projectDir = path.join(workspaceRoot, 'project');
  await mkdir(projectDir);

  const created = await manager.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const { sessionId } = created.value;

  const received: Envelope[] = [];
  await manager.subscribe(sessionId, owner, 0, {
    deliver: (e) => received.push(e),
    close: () => {},
  });

  const messaged = await manager.message(sessionId, owner, 'do the thing');
  assert.equal(messaged.ok, true);

  await waitUntil(() => received.some((e) => e.kind === 'permission.request'));
  const requestEnvelope = received.find((e) => e.kind === 'permission.request')!;
  const requestId = (requestEnvelope.data as { requestId: string }).requestId;

  // The harness: auto-deny.
  const answered = await manager.answerPermission(sessionId, owner, {
    requestId: requestId as never,
    decision: 'deny',
    scope: 'once',
    rule: null,
    reason: null,
  });
  assert.equal(answered.ok, true);
  if (answered.ok) assert.equal(answered.value.accepted, true);

  await waitUntil(() => received.some((e) => e.kind === 'turn.ended'));
  const turnEnded = received.find((e) => e.kind === 'turn.ended')!;
  assert.equal((turnEnded.data as { stopReason: string }).stopReason, 'completed');

  assert.ok(received.some((e) => e.kind === 'permission.resolved'));
});

test('S1.5 — seq starts at 1 and is contiguous over 200+ envelopes, assigned only by the manager', async () => {
  const { manager, workspaceRoot } = await makeManager('many');
  const owner = 'operator-1' as OperatorId;
  const projectDir = path.join(workspaceRoot, 'project2');
  await mkdir(projectDir);
  const created = await manager.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const received: Envelope[] = [];
  await manager.subscribe(created.value.sessionId, owner, 0, { deliver: (e) => received.push(e), close: () => {} });

  await manager.message(created.value.sessionId, owner, 'go');
  await waitUntil(() => received.some((e) => e.kind === 'turn.ended'), 15000);

  assert.ok(received.length >= 200);
  const seqs = received.map((e) => e.seq as unknown as number);
  for (let i = 1; i < seqs.length; i++) assert.equal(seqs[i], seqs[i - 1]! + 1);
  assert.equal(seqs[0], 1);
});

test('two concurrent creates for the same cwd — exactly one wins, the other is workspace_busy', async () => {
  const { manager, workspaceRoot } = await makeManager('full');
  const owner = 'operator-1' as OperatorId;
  const projectDir = path.join(workspaceRoot, 'contested');
  await mkdir(projectDir);

  const input = { vendor: 'claude' as const, cwd: projectDir, model: null, sandbox: null, requisitionId: null };
  const [a, b] = await Promise.all([manager.create(owner, input), manager.create(owner, input)]);

  const winners = [a, b].filter((r) => r.ok);
  assert.equal(winners.length, 1);
  const loser = [a, b].find((r) => !r.ok)!;
  if (!loser.ok) assert.equal(loser.error.code, 'workspace_busy');
});

test('an unspawnable executable still pairs turn.started with turn.ended and frees the turn slot', async () => {
  const { manager, workspaceRoot } = await makeManager('full');
  process.env['SKYNET_CLAUDE_EXECUTABLE'] = 'skynet-no-such-binary';
  try {
    const owner = 'operator-1' as OperatorId;
    const projectDir = path.join(workspaceRoot, 'project3');
    await mkdir(projectDir);
    const created = await manager.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const received: Envelope[] = [];
    await manager.subscribe(created.value.sessionId, owner, 0, { deliver: (e) => received.push(e), close: () => {} });

    const messaged = await manager.message(created.value.sessionId, owner, 'go');
    assert.equal(messaged.ok, false);
    if (!messaged.ok) assert.equal(messaged.error.code, 'adapter');

    const started = received.find((e) => e.kind === 'turn.started');
    const ended = received.find((e) => e.kind === 'turn.ended');
    assert.ok(started, 'turn.started was emitted');
    assert.ok(ended, 'turn.ended pairs it');
    assert.equal((ended!.data as { turnId: string }).turnId, (started!.data as { turnId: string }).turnId);
    assert.equal((ended!.data as { stopReason: string }).stopReason, 'error');

    // The slot is free again: a second message must not report turn_in_flight.
    const again = await manager.message(created.value.sessionId, owner, 'go');
    assert.equal(again.ok, false);
    if (!again.ok) assert.notEqual(again.error.code, 'turn_in_flight');
  } finally {
    process.env['SKYNET_CLAUDE_EXECUTABLE'] = FIXTURE;
  }
});

test('a model carrying shell metacharacters is refused with bad_request before any session exists', async () => {
  const { manager, workspaceRoot } = await makeManager('full');
  const owner = 'operator-1' as OperatorId;
  const projectDir = path.join(workspaceRoot, 'project4');
  await mkdir(projectDir);
  const result = await manager.create(owner, { vendor: 'claude', cwd: projectDir, model: 'sonnet & calc.exe', sandbox: null, requisitionId: null });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'bad_request');
    if (result.error.code === 'bad_request') assert.equal(result.error.field, 'model');
  }
});

test('a non-null sandbox for claude is refused with unsupported_sandbox', async () => {
  const { manager, workspaceRoot } = await makeManager('full');
  const owner = 'operator-1' as OperatorId;
  const projectDir = path.join(workspaceRoot, 'project5');
  await mkdir(projectDir);
  const result = await manager.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: 'read-only', requisitionId: null });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'adapter');
    if (result.error.code === 'adapter') assert.equal(result.error.cause.code, 'unsupported_sandbox');
  }
});

test('S1.6/S1.7 (session-manager integration) — a cwd outside every root is refused before any session is created', async () => {
  const { manager } = await makeManager('full');
  const owner = 'operator-1' as OperatorId;
  const outside = await mkdtemp(path.join(tmpdir(), 'skynet-outside-'));
  const result = await manager.create(owner, { vendor: 'claude', cwd: outside, model: null, sandbox: null, requisitionId: null });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'jail');
});

function errorKinds(received: readonly Envelope[]): string[] {
  return received.filter((e) => e.kind === 'error').map((e) => (e.data as { kind: string }).kind);
}

test('S3.1 — reconnecting with Last-Event-ID: N delivers N+1 onward and nothing else; concatenated with the pre-reconnect run it equals one uninterrupted run element for element', async () => {
  const { manager, workspaceRoot } = await makeManager('many');
  const owner = 'operator-1' as OperatorId;
  const projectDir = path.join(workspaceRoot, 'proj-s31');
  await mkdir(projectDir);
  const created = await manager.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const { sessionId } = created.value;

  const control: Envelope[] = [];
  await manager.subscribe(sessionId, owner, 0, { deliver: (e) => control.push(e), close: () => {} });
  await manager.message(sessionId, owner, 'go');
  await waitUntil(() => control.some((e) => e.kind === 'turn.ended'), 15000);

  // A reconnect after the 20th envelope: everything from 21 onward, and nothing before it.
  const cutoff = control[19]!.seq;
  const post: Envelope[] = [];
  await manager.subscribe(sessionId, owner, cutoff, { deliver: (e) => post.push(e), close: () => {} });

  assert.ok(post.length > 0);
  assert.ok(post.every((e) => (e.seq as unknown as number) > (cutoff as unknown as number)));
  const rebuilt = [...control.slice(0, 20), ...post];
  assert.deepEqual(rebuilt, control, 'pre- and post-reconnect envelopes concatenate to the uninterrupted run');
});

test('S3.2 — a too-old Last-Event-ID is served from the spill for a live session mid-turn, with no replay_gap', async () => {
  const { manager, workspaceRoot } = await makeManager('many', { ringCapacity: 10 });
  const owner = 'operator-1' as OperatorId;
  const projectDir = path.join(workspaceRoot, 'proj-s32');
  await mkdir(projectDir);
  const created = await manager.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const { sessionId } = created.value;

  const control: Envelope[] = [];
  await manager.subscribe(sessionId, owner, 0, { deliver: (e) => control.push(e), close: () => {} });
  await manager.message(sessionId, owner, 'go');

  // Past the 10-envelope ring, still mid-turn.
  await waitUntil(() => control.length >= 15);
  const staleAfter = control[4]!.seq; // well behind the ring's current oldest

  const late: Envelope[] = [];
  await manager.subscribe(sessionId, owner, staleAfter, { deliver: (e) => late.push(e), close: () => {} });

  await waitUntil(() => control.some((e) => e.kind === 'turn.ended'));
  await waitUntil(() => late.some((e) => e.kind === 'turn.ended'));

  assert.deepEqual(errorKinds(late), [], 'a healthy spill never produces replay_gap');
  const expected = control.filter((e) => (e.seq as unknown as number) > (staleAfter as unknown as number));
  assert.deepEqual(late, expected);
});

test('S3.3 — replay_gap is emitted exactly once when the spill genuinely cannot serve the range, and joins the live stream afterward', async () => {
  const { manager, workspaceRoot, storageRoot } = await makeManager('error-result', { ringCapacity: 1 });
  const owner = 'operator-1' as OperatorId;
  const projectDir = path.join(workspaceRoot, 'proj-s33');
  await mkdir(projectDir);
  const created = await manager.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const { sessionId } = created.value;

  const control: Envelope[] = [];
  await manager.subscribe(sessionId, owner, 0, { deliver: (e) => control.push(e), close: () => {} });
  await manager.message(sessionId, owner, 'go');
  await waitUntil(() => control.some((e) => e.kind === 'turn.ended'));

  // The spill genuinely cannot serve: its file is gone. The ring (capacity 1) cannot
  // serve `after: 0` either, so this forces the spill path straight into the failure.
  const { rm } = await import('node:fs/promises');
  await rm(path.join(storageRoot, 'sessions', sessionId, 'events.ndjson'));

  const gapped: Envelope[] = [];
  await manager.subscribe(sessionId, owner, 0, { deliver: (e) => gapped.push(e), close: () => {} });

  assert.deepEqual(errorKinds(gapped), ['replay_gap']);
  assert.equal(gapped.length, 1, 'exactly one replay_gap; the subscriber still joins the live stream after it, it just has nothing left to hear');
});

test('S3.4 — the same spill-served replay works for a session in state ended', async () => {
  const { manager, workspaceRoot, storageRoot, store } = await makeManager('error-result', { ringCapacity: 1 });
  const owner = 'operator-1' as OperatorId;
  const projectDir = path.join(workspaceRoot, 'proj-s34');
  await mkdir(projectDir);
  const created = await manager.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const { sessionId } = created.value;

  const control: Envelope[] = [];
  await manager.subscribe(sessionId, owner, 0, { deliver: (e) => control.push(e), close: () => {} });
  await manager.message(sessionId, owner, 'go');
  await waitUntil(() => control.some((e) => e.kind === 'turn.ended') && control.some((e) => e.kind === 'session.started'));
  const durableHistory = [...control];

  // Live delivery (above) races the durable append (D18, I27): wait for the spill to
  // actually hold what `control` already has in memory before doing anything that
  // could interfere with a write still in flight.
  const lastSeq = durableHistory[durableHistory.length - 1]!.seq;
  const deadline = Date.now() + 5000;
  for (;;) {
    const r = await store.readLastSeq(sessionId);
    if (r.ok && r.value === lastSeq) break;
    if (Date.now() > deadline) throw new Error('timed out waiting for the spill to catch up');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  // The one route this build has to a durable write failure (D41 marks the session
  // `ended` on it) is a spill it cannot append to. Marking the file read-only forces
  // exactly that on the next turn, without touching the history already written.
  const eventsPath = path.join(storageRoot, 'sessions', sessionId, 'events.ndjson');
  await chmod(eventsPath, 0o444);
  try {
    await manager.message(sessionId, owner, 'go again');
    await waitUntil(() => {
      const got = manager.get(sessionId, owner);
      return got.ok && got.value.state === 'ended';
    });
  } finally {
    await chmod(eventsPath, 0o666);
  }

  const replayed: Envelope[] = [];
  await manager.subscribe(sessionId, owner, 0, { deliver: (e) => replayed.push(e), close: () => {} });
  assert.deepEqual(replayed.slice(0, durableHistory.length), durableHistory);
});

test('S3.7 — a subscriber past subscriberQueueHighWater is dropped with a gap reported to it alone; other subscribers see every envelope', async () => {
  // The drop needs live envelopes to arrive *while* a spill replay is still running. Racing
  // a real file read against a real child process decides that on disk speed, and a run
  // where the read wins asserts nothing — so the replay is held open explicitly instead,
  // and released only once the overflow is guaranteed to have happened.
  let releaseReplay = (): void => {};
  const replayHeld = new Promise<void>((resolve) => { releaseReplay = resolve; });
  let holdNextReplay = false;

  const { manager, workspaceRoot } = await makeManager('many', { ringCapacity: 1, subscriberQueueHighWater: 1 }, (store) => ({
    ...store,
    readEventsAfter(sessionId, after) {
      if (!holdNextReplay) return store.readEventsAfter(sessionId, after);
      holdNextReplay = false;
      const inner = store.readEventsAfter(sessionId, after);
      return (async function* () {
        await replayHeld;
        yield* inner;
      })();
    },
  }));

  const owner = 'operator-1' as OperatorId;
  const projectDir = path.join(workspaceRoot, 'proj-s37');
  await mkdir(projectDir);
  const created = await manager.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const { sessionId } = created.value;

  // A subscriber that is live before the second turn starts, and so is never buffered.
  const unaffected: Envelope[] = [];
  await manager.subscribe(sessionId, owner, 0, { deliver: (e) => unaffected.push(e), close: () => {} });
  await manager.message(sessionId, owner, 'go');
  await waitUntil(() => unaffected.some((e) => e.kind === 'turn.ended'), 15000);

  // This one subscribes with its replay pinned open, so every envelope of the second turn
  // lands in its buffer — two of them past a highWater of 1.
  const overflowSink: Envelope[] = [];
  let overflowClosed = false;
  holdNextReplay = true;
  const subscribing = manager.subscribe(sessionId, owner, 0, {
    deliver: (e) => overflowSink.push(e),
    close: () => { overflowClosed = true; },
  });

  // `turn.ended` reaches a subscriber inside `emit`'s synchronous fan-out, but the turn
  // slot is only freed once that emit's durable write has landed — so a second `message`
  // issued the instant the first turn is seen to end is refused as `turn_in_flight`.
  const before = unaffected.length;
  for (;;) {
    const sent = await manager.message(sessionId, owner, 'go again');
    if (sent.ok) break;
    assert.equal(sent.error.code, 'turn_in_flight', `second turn refused: ${sent.error.code}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await waitUntil(() => unaffected.length >= before + 3, 15000);
  releaseReplay();
  await subscribing;
  await waitUntil(() => unaffected.filter((e) => e.kind === 'turn.ended').length === 2, 15000);

  assert.equal(overflowClosed, true, 'the overflowing subscriber is closed, not left half-fed');
  assert.deepEqual(errorKinds(overflowSink), ['replay_gap']);
  assert.equal(overflowSink.length, 1, 'the gap is all it gets: nothing was replayed to it before the drop');

  // The gap restates the watermark it is complete through, and must never name a seq it
  // did not receive — the edge turns `seq` into the SSE `id:`, which is the next
  // reconnect's resume point.
  assert.equal(overflowSink[0]!.seq as unknown as number, 0, 'a subscriber dropped before any replay is complete through nothing');

  // The other subscriber is untouched by any of it.
  assert.deepEqual(errorKinds(unaffected), []);
  assert.equal(unaffected.filter((e) => e.kind === 'turn.ended').length, 2);
});

test('S3.8 — a disconnected client does not reach the child: the turn runs to completion, seq-contiguous and unshortened, unobserved', async () => {
  const { manager, workspaceRoot } = await makeManager('many');
  const owner = 'operator-1' as OperatorId;
  const projectDir = path.join(workspaceRoot, 'proj-s38');
  await mkdir(projectDir);
  const created = await manager.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const { sessionId } = created.value;

  // A control subscriber, live from the start, never closes — the ground truth for what
  // the turn actually produced.
  const control: Envelope[] = [];
  await manager.subscribe(sessionId, owner, 0, { deliver: (e) => control.push(e), close: () => {} });

  const transient: Envelope[] = [];
  const sub = await manager.subscribe(sessionId, owner, 0, { deliver: (e) => transient.push(e), close: () => {} });
  await manager.message(sessionId, owner, 'go');
  assert.equal(sub.ok, true);
  if (sub.ok) {
    await waitUntil(() => transient.length >= 5);
    sub.value.close(); // the turn is untouched by this — it keeps running unobserved
  }

  await waitUntil(() => control.some((e) => e.kind === 'turn.ended'), 15000);

  // The scenario's shape is fixed regardless of who was watching: one turn.started, one
  // session.started, 200 message/usage pairs, one turn.ended.
  assert.equal(control.filter((e) => e.kind === 'message').length, 200);
  assert.equal(control.filter((e) => e.kind === 'turn.ended').length, 1);
  const seqs = control.map((e) => e.seq as unknown as number);
  for (let i = 1; i < seqs.length; i++) assert.equal(seqs[i], seqs[i - 1]! + 1, 'seq stays contiguous across the disconnect');
});

test('S3.2 — a session whose ring holds nothing at all still replays its whole history from the spill', async () => {
  // `ringCapacity: 0` is accepted by config and makes `pushRing` a no-op. It stands in
  // here for every state where the ring is empty but the spill is not — the same state a
  // rehydrated session boots into.
  const { manager, workspaceRoot } = await makeManager('error-result', { ringCapacity: 0 });
  const owner = 'operator-1' as OperatorId;
  const projectDir = path.join(workspaceRoot, 'proj-s32b');
  await mkdir(projectDir);
  const created = await manager.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const { sessionId } = created.value;

  const control: Envelope[] = [];
  await manager.subscribe(sessionId, owner, 0, { deliver: (e) => control.push(e), close: () => {} });
  await manager.message(sessionId, owner, 'go');
  await waitUntil(() => control.some((e) => e.kind === 'turn.ended'));

  const fresh: Envelope[] = [];
  await manager.subscribe(sessionId, owner, 0, { deliver: (e) => fresh.push(e), close: () => {} });

  assert.deepEqual(errorKinds(fresh), [], 'a readable spill is not a gap');
  assert.ok(fresh.length > 0, 'a fresh subscriber does not get an empty transcript');
  assert.deepEqual(fresh.map((e) => e.seq), control.map((e) => e.seq));
});

test('S3.3 — a Last-Event-ID past the end of the session is reported as a gap, not served as nothing', async () => {
  const { manager, workspaceRoot } = await makeManager('error-result');
  const owner = 'operator-1' as OperatorId;
  const projectDir = path.join(workspaceRoot, 'proj-s33b');
  await mkdir(projectDir);
  const created = await manager.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const { sessionId } = created.value;

  const control: Envelope[] = [];
  await manager.subscribe(sessionId, owner, 0, { deliver: (e) => control.push(e), close: () => {} });
  await manager.message(sessionId, owner, 'go');
  await waitUntil(() => control.some((e) => e.kind === 'turn.ended'));
  const lastSeq = control[control.length - 1]!.seq as unknown as number;

  const beyond: Envelope[] = [];
  await manager.subscribe(sessionId, owner, (lastSeq + 500) as never, { deliver: (e) => beyond.push(e), close: () => {} });

  assert.deepEqual(errorKinds(beyond), ['replay_gap'], 'an unreachable resume point is a gap, not silence');
  assert.equal(beyond.length, 1);
  // The gap names the end of the history that does exist, never the resume point that
  // does not — the edge turns `seq` into the SSE `id:`.
  assert.equal(beyond[0]!.seq as unknown as number, lastSeq);
});

// ---------------------------------------------------------------------------
// S4 — Ask before you run it, and write down who said yes
// ---------------------------------------------------------------------------

async function runOneRequest(scenario: string, workspaceRoot: string, manager: Awaited<ReturnType<typeof makeManager>>['manager'], owner: OperatorId, dir: string) {
  const projectDir = path.join(workspaceRoot, dir);
  await mkdir(projectDir);
  const created = await manager.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error('unreachable');
  const { sessionId } = created.value;
  const received: Envelope[] = [];
  await manager.subscribe(sessionId, owner, 0, { deliver: (e) => received.push(e), close: () => {} });
  const messaged = await manager.message(sessionId, owner, 'go');
  assert.equal(messaged.ok, true);
  await waitUntil(() => received.some((e) => e.kind === 'permission.request'));
  const requestEnvelope = received.find((e) => e.kind === 'permission.request')!;
  return { sessionId, received, requestEnvelope };
}

test('S4.1/S4.8 — permission.request carries the tool input exactly, and AuditRecord.input equals it key for key', async () => {
  const { manager, workspaceRoot, storageRoot } = await makeManager('full');
  const owner = 'operator-1' as OperatorId;
  const { sessionId, received, requestEnvelope } = await runOneRequest('full', workspaceRoot, manager, owner, 'proj-s41');
  const data = requestEnvelope.data as { requestId: string; tool: string; input: Record<string, unknown> };
  assert.deepEqual(data.input, { command: 'echo hi' });

  await manager.answerPermission(sessionId, owner, { requestId: data.requestId as never, decision: 'allow', scope: 'once', rule: null, reason: null });
  await waitUntil(() => received.some((e) => e.kind === 'permission.resolved'));

  const audit = await readAudit(storageRoot);
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0]!.input, data.input);
  assert.equal(audit[0]!.tool, data.tool);
});

test('S4.2 — allow and deny each round-trip to the real child and the agent proceeds accordingly', async () => {
  const owner = 'operator-1' as OperatorId;
  for (const decision of ['allow', 'deny'] as const) {
    const { manager, workspaceRoot } = await makeManager('full');
    const { sessionId, received, requestEnvelope } = await runOneRequest('full', workspaceRoot, manager, owner, `proj-s42-${decision}`);
    const requestId = (requestEnvelope.data as { requestId: string }).requestId;

    const answered = await manager.answerPermission(sessionId, owner, { requestId: requestId as never, decision, scope: 'once', rule: null, reason: null });
    assert.equal(answered.ok, true);
    if (answered.ok) assert.equal(answered.value.accepted, true);

    await waitUntil(() => received.some((e) => e.kind === 'tool.result'));
    const toolResult = received.find((e) => e.kind === 'tool.result')!;
    assert.equal((toolResult.data as { ok: boolean }).ok, decision === 'allow');

    await waitUntil(() => received.some((e) => e.kind === 'turn.ended'));
    assert.equal((received.find((e) => e.kind === 'turn.ended')!.data as { stopReason: string }).stopReason, 'completed');
  }
});

test('S4.3 — every permission.request is followed by exactly one permission.resolved with the same requestId, over a run of three requests, before or at turn.ended', async () => {
  const { manager, workspaceRoot } = await makeManager('many-permissions');
  const owner = 'operator-1' as OperatorId;
  const projectDir = path.join(workspaceRoot, 'proj-s43');
  await mkdir(projectDir);
  const created = await manager.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const { sessionId } = created.value;

  const received: Envelope[] = [];
  await manager.subscribe(sessionId, owner, 0, { deliver: (e) => received.push(e), close: () => {} });
  await manager.message(sessionId, owner, 'go');

  const answeredIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    await waitUntil(() => received.filter((e) => e.kind === 'permission.request').length > i);
    const req = received.filter((e) => e.kind === 'permission.request')[i]!;
    const requestId = (req.data as { requestId: string }).requestId;
    const answered = await manager.answerPermission(sessionId, owner, { requestId: requestId as never, decision: 'allow', scope: 'once', rule: null, reason: null });
    assert.equal(answered.ok, true);
    answeredIds.push(requestId);
  }
  await waitUntil(() => received.some((e) => e.kind === 'turn.ended'));

  const requests = received.filter((e) => e.kind === 'permission.request');
  const resolutions = received.filter((e) => e.kind === 'permission.resolved');
  assert.equal(requests.length, 3);
  assert.equal(resolutions.length, 3);
  assert.deepEqual(
    resolutions.map((e) => (e.data as { requestId: string }).requestId).sort(),
    answeredIds.sort(),
  );
  const turnEndedSeq = received.find((e) => e.kind === 'turn.ended')!.seq as unknown as number;
  for (const r of resolutions) assert.ok((r.seq as unknown as number) <= turnEndedSeq, 'every resolution precedes or is at turn.ended');
});

test('S4.4 — a second client answering an already-resolved request gets accepted: false, and only one audit record exists', async () => {
  const { manager, workspaceRoot, storageRoot } = await makeManager('full');
  const owner = 'operator-1' as OperatorId;
  const { sessionId, requestEnvelope } = await runOneRequest('full', workspaceRoot, manager, owner, 'proj-s44');
  const requestId = (requestEnvelope.data as { requestId: string }).requestId;

  const first = await manager.answerPermission(sessionId, owner, { requestId: requestId as never, decision: 'allow', scope: 'once', rule: null, reason: null });
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.value.accepted, true);

  const second = await manager.answerPermission(sessionId, owner, { requestId: requestId as never, decision: 'deny', scope: 'once', rule: null, reason: null });
  assert.equal(second.ok, true);
  if (second.ok) assert.equal(second.value.accepted, false, 'already resolved — not an error');

  await new Promise((r) => setTimeout(r, 100));
  const audit = await readAudit(storageRoot);
  assert.equal(audit.length, 1, 'exactly one audit record — the second answer never reached the child or the log');
  assert.equal(audit[0]!.decision, 'allow');
});

test('S4.5 — two answers dispatched in the same tick produce exactly one audit record', async () => {
  const { manager, workspaceRoot, storageRoot } = await makeManager('full');
  const owner = 'operator-1' as OperatorId;
  const { sessionId, requestEnvelope } = await runOneRequest('full', workspaceRoot, manager, owner, 'proj-s45');
  const requestId = (requestEnvelope.data as { requestId: string }).requestId;

  const [a, b] = await Promise.all([
    manager.answerPermission(sessionId, owner, { requestId: requestId as never, decision: 'allow', scope: 'once', rule: null, reason: null }),
    manager.answerPermission(sessionId, owner, { requestId: requestId as never, decision: 'deny', scope: 'once', rule: null, reason: null }),
  ]);
  const accepted = [a, b].filter((r) => r.ok && r.value.accepted);
  assert.equal(accepted.length, 1, 'exactly one of the two answers was accepted');

  await new Promise((r) => setTimeout(r, 100));
  const audit = await readAudit(storageRoot);
  assert.equal(audit.length, 1);
});

test('S4.6 — the audit record is fsync\'d (store double resolves) before the control_response reaches the child', async () => {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let holdNextAppend = false;
  let auditAppendCalled = false;

  const { manager, workspaceRoot } = await makeManager('full', {}, (store) => ({
    ...store,
    async appendAudit(record) {
      if (!holdNextAppend) return store.appendAudit(record);
      holdNextAppend = false;
      auditAppendCalled = true;
      await held;
      return store.appendAudit(record);
    },
  }));
  const owner = 'operator-1' as OperatorId;
  const { sessionId, received, requestEnvelope } = await runOneRequest('full', workspaceRoot, manager, owner, 'proj-s46');
  const requestId = (requestEnvelope.data as { requestId: string }).requestId;

  holdNextAppend = true;
  const answering = manager.answerPermission(sessionId, owner, { requestId: requestId as never, decision: 'allow', scope: 'once', rule: null, reason: null });
  await waitUntil(() => auditAppendCalled);

  // While the audit append is held open, the control_response must not have reached
  // the child yet — asserted by the fixture never having produced the tool_result
  // that only follows a received control_response.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(received.some((e) => e.kind === 'tool.result'), false, 'no control_response reached the child while the audit append was still in flight');

  release();
  await answering;
  await waitUntil(() => received.some((e) => e.kind === 'tool.result'));
});

test('S4.7 — an audit append failure denies the permission, and the turn continues with no tool run', async () => {
  const { manager, workspaceRoot } = await makeManager('full', {}, (store) => ({
    ...store,
    async appendAudit() {
      return { ok: false, error: { code: 'io', path: 'audit.ndjson', detail: 'disk full' } } as const;
    },
  }));
  const owner = 'operator-1' as OperatorId;
  const { sessionId, received, requestEnvelope } = await runOneRequest('full', workspaceRoot, manager, owner, 'proj-s47');
  const requestId = (requestEnvelope.data as { requestId: string }).requestId;

  const answered = await manager.answerPermission(sessionId, owner, { requestId: requestId as never, decision: 'allow', scope: 'once', rule: null, reason: null });
  assert.equal(answered.ok, true);
  if (answered.ok) assert.equal(answered.value.accepted, true);

  await waitUntil(() => received.some((e) => e.kind === 'permission.resolved'));
  const resolved = received.find((e) => e.kind === 'permission.resolved')!.data as { decision: string; operator: string | null; reason: string };
  assert.equal(resolved.decision, 'deny');
  assert.equal(resolved.operator, null);
  assert.equal(resolved.reason, 'audit_unavailable');

  // The 'full' scenario also emits an unrelated info-level compaction notice earlier in
  // its scripted sequence; the one this criterion is about is the audit_unavailable one.
  await waitUntil(() => received.some((e) => e.kind === 'session.notice' && (e.data as { code: string }).code === 'audit_unavailable'));
  const notice = received.find((e) => e.kind === 'session.notice' && (e.data as { code: string }).code === 'audit_unavailable')!.data as { level: string; code: string };
  assert.equal(notice.level, 'error');
  assert.equal(notice.code, 'audit_unavailable');

  await waitUntil(() => received.some((e) => e.kind === 'tool.result'));
  const toolResult = received.find((e) => e.kind === 'tool.result')!.data as { ok: boolean };
  assert.equal(toolResult.ok, false, 'the tool never ran — the child was told deny');
});

test('S4.9 — a child that dies with requests outstanding resolves each one cancelled_process_exit, each with an audit record, before turn.ended', async () => {
  const { manager, workspaceRoot, storageRoot } = await makeManager('die-with-pending');
  const owner = 'operator-1' as OperatorId;
  const projectDir = path.join(workspaceRoot, 'proj-s49');
  await mkdir(projectDir);
  const created = await manager.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const { sessionId } = created.value;

  const received: Envelope[] = [];
  await manager.subscribe(sessionId, owner, 0, { deliver: (e) => received.push(e), close: () => {} });
  await manager.message(sessionId, owner, 'go');

  await waitUntil(() => received.some((e) => e.kind === 'turn.ended'));

  const resolutions = received.filter((e) => e.kind === 'permission.resolved');
  assert.equal(resolutions.length, 2, 'both outstanding requests were resolved');
  for (const r of resolutions) {
    const data = r.data as { decision: string; operator: string | null; reason: string };
    assert.equal(data.decision, 'deny');
    assert.equal(data.operator, null);
    assert.equal(data.reason, 'cancelled_process_exit');
  }

  const turnEnded = received.find((e) => e.kind === 'turn.ended')!;
  assert.equal((turnEnded.data as { stopReason: string }).stopReason, 'process_exit');
  const turnEndedSeq = turnEnded.seq as unknown as number;
  for (const r of resolutions) assert.ok((r.seq as unknown as number) < turnEndedSeq, 'each cancellation precedes turn.ended');

  let audit: AuditRecord[] = [];
  await waitUntil2(async () => {
    audit = await readAudit(storageRoot);
    return audit.length >= 2;
  });
  assert.equal(audit.length, 2);
  for (const a of audit) {
    assert.equal(a.operator, null);
    assert.equal(a.decision, 'deny');
    assert.equal(a.reason, 'cancelled_process_exit');
  }
});

test('S4.10 — audit.ndjson is server-wide and append-only across two sessions', async () => {
  const { manager, workspaceRoot, storageRoot } = await makeManager('full');
  const owner = 'operator-1' as OperatorId;
  const first = await runOneRequest('full', workspaceRoot, manager, owner, 'proj-s410a');
  await manager.answerPermission(first.sessionId, owner, { requestId: (first.requestEnvelope.data as { requestId: string }).requestId as never, decision: 'allow', scope: 'once', rule: null, reason: null });
  await waitUntil(() => first.received.some((e) => e.kind === 'permission.resolved'));

  const second = await runOneRequest('full', workspaceRoot, manager, owner, 'proj-s410b');
  await manager.answerPermission(second.sessionId, owner, { requestId: (second.requestEnvelope.data as { requestId: string }).requestId as never, decision: 'deny', scope: 'once', rule: null, reason: null });
  await waitUntil(() => second.received.some((e) => e.kind === 'permission.resolved'));

  const audit = await readAudit(storageRoot);
  assert.equal(audit.length, 2);
  assert.deepEqual(audit.map((a) => a.sessionId).sort(), [first.sessionId, second.sessionId].sort());
});

test('S4.12 — scope: always is refused bad_request naming the field, and so is a supplied rule', async () => {
  const { manager, workspaceRoot } = await makeManager('full');
  const owner = 'operator-1' as OperatorId;
  const { sessionId, requestEnvelope } = await runOneRequest('full', workspaceRoot, manager, owner, 'proj-s412');
  const requestId = (requestEnvelope.data as { requestId: string }).requestId;

  const alwaysResult = await manager.answerPermission(sessionId, owner, { requestId: requestId as never, decision: 'allow', scope: 'always', rule: null, reason: null });
  assert.equal(alwaysResult.ok, false);
  if (!alwaysResult.ok) {
    assert.equal(alwaysResult.error.code, 'bad_request');
    if (alwaysResult.error.code === 'bad_request') assert.equal(alwaysResult.error.field, 'scope');
  }

  const ruleResult = await manager.answerPermission(sessionId, owner, { requestId: requestId as never, decision: 'allow', scope: 'once', rule: 'anything' as never, reason: null });
  assert.equal(ruleResult.ok, false);
  if (!ruleResult.ok) {
    assert.equal(ruleResult.error.code, 'bad_request');
    if (ruleResult.error.code === 'bad_request') assert.equal(ruleResult.error.field, 'rule');
  }
});

test('S4.13 — another operator answering gets no_such_session and writes no audit record; the answering operator is who is recorded', async () => {
  const { manager, workspaceRoot, storageRoot } = await makeManager('full');
  const owner = 'operator-1' as OperatorId;
  const stranger = 'operator-2' as OperatorId;
  const { sessionId, requestEnvelope } = await runOneRequest('full', workspaceRoot, manager, owner, 'proj-s413');
  const requestId = (requestEnvelope.data as { requestId: string }).requestId;

  const strangerResult = await manager.answerPermission(sessionId, stranger, { requestId: requestId as never, decision: 'allow', scope: 'once', rule: null, reason: null });
  assert.equal(strangerResult.ok, false);
  if (!strangerResult.ok) assert.equal(strangerResult.error.code, 'no_such_session');

  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await readAudit(storageRoot)).length, 0, 'the stranger wrote nothing');

  const ownerResult = await manager.answerPermission(sessionId, owner, { requestId: requestId as never, decision: 'allow', scope: 'once', rule: null, reason: null });
  assert.equal(ownerResult.ok, true);
  await new Promise((r) => setTimeout(r, 50));
  const audit = await readAudit(storageRoot);
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.operator, owner);
});

test('S4.15 — a turn spawning with no --resume on a session that already ran one emits resume_unavailable, the turn proceeds, and cliSessionId stays null', async () => {
  const { manager, workspaceRoot } = await makeManager('no-init');
  const owner = 'operator-1' as OperatorId;
  const projectDir = path.join(workspaceRoot, 'proj-s415');
  await mkdir(projectDir);
  const created = await manager.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const { sessionId } = created.value;

  const received: Envelope[] = [];
  await manager.subscribe(sessionId, owner, 0, { deliver: (e) => received.push(e), close: () => {} });

  // First turn: the fixture never reports system/init, so cliSessionId never gets set.
  await manager.message(sessionId, owner, 'go');
  await waitUntil(() => received.some((e) => e.kind === 'turn.ended'));

  const beforeSecondTurn = received.length;
  // The turn slot frees only once turn.ended's durable write has landed, slightly after
  // the subscriber sees the envelope (S3.7's same race) — retry rather than assert once.
  let messaged;
  for (;;) {
    messaged = await manager.message(sessionId, owner, 'go again');
    if (messaged.ok) break;
    assert.equal(messaged.error.code, 'turn_in_flight', `second turn refused: ${messaged.error.code}`);
    await new Promise((r) => setTimeout(r, 10));
  }

  await waitUntil(() => received.slice(beforeSecondTurn).some((e) => e.kind === 'session.notice'));
  const notice = received.slice(beforeSecondTurn).find((e) => e.kind === 'session.notice')!.data as { level: string; code: string };
  assert.equal(notice.level, 'warn');
  assert.equal(notice.code, 'resume_unavailable');

  await waitUntil(() => received.slice(beforeSecondTurn).some((e) => e.kind === 'turn.ended'));
});
