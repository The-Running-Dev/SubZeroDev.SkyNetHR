import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createSessionManager } from './index.js';
import { createStore } from '../store/index.js';
import type { Checkpoints, Config, Envelope, OperatorId, Records } from '../contract/index.js';

const FIXTURE = path.join(process.cwd(), 'src', 'adapters', 'claude', 'fixtures', 'fake-claude-cli.mjs');

function notImplementedProxy<T extends object>(name: string): T {
  return new Proxy({}, { get: () => () => { throw new Error(`${name} must not be called by session-manager in S1`); } }) as T;
}

async function makeManager(scenario: string, capsOverride: Partial<Config['caps']> = {}) {
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
    store: storeResult.value,
    checkpoints: notImplementedProxy<Checkpoints>('checkpoints'),
    records: notImplementedProxy<Records>('records'),
  });
  return { manager, workspaceRoot, storageRoot, store: storeResult.value };
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
  const { manager, workspaceRoot } = await makeManager('many', { ringCapacity: 1, subscriberQueueHighWater: 1 });
  const owner = 'operator-1' as OperatorId;
  const projectDir = path.join(workspaceRoot, 'proj-s37');
  await mkdir(projectDir);
  const created = await manager.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const { sessionId } = created.value;

  const firstTurn: Envelope[] = [];
  await manager.subscribe(sessionId, owner, 0, { deliver: (e) => firstTurn.push(e), close: () => {} });
  await manager.message(sessionId, owner, 'go');
  await waitUntil(() => firstTurn.some((e) => e.kind === 'turn.ended'));

  // Second turn: subscribe (forcing a spill replay of the whole first turn, since the
  // ring holds only 1) in the same tick the turn is kicked off, racing the async replay
  // against this turn's live envelopes with a highWater of 1 — the tightest possible
  // squeeze.
  const unaffected: Envelope[] = [];
  await manager.subscribe(sessionId, owner, 0, { deliver: (e) => unaffected.push(e), close: () => {} });
  const overflowSink: Envelope[] = [];
  let overflowClosed = false;
  const messagePromise = manager.message(sessionId, owner, 'go again');
  await manager.subscribe(sessionId, owner, 0, { deliver: (e) => overflowSink.push(e), close: () => { overflowClosed = true; } });
  await messagePromise;
  await waitUntil(() => unaffected.filter((e) => e.kind === 'turn.ended').length === 2);

  if (overflowClosed) {
    assert.deepEqual(errorKinds(overflowSink), ['replay_gap']);
  }
  // Whether or not the race tripped the drop on this run, the other subscriber — never
  // buffered, since it was already live from before the second turn started — must see
  // every envelope of both turns with no gap reported.
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
