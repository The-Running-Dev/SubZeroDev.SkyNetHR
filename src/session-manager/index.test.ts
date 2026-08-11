import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { createSessionManager } from './index.js';
import { createStore } from '../store/index.js';
import { createCheckpoints } from '../checkpoints/index.js';
import type { AuditRecord, Checkpoints, Config, Envelope, IsoTimestamp, OperatorId, ProcessRecord, Records, SessionId, Store, TurnId } from '../contract/index.js';

const execFileAsync = promisify(execFile);

const FIXTURE = path.join(process.cwd(), 'src', 'adapters', 'claude', 'fixtures', 'fake-claude-cli.mjs');

// A turn deliberately left stalled on an unanswered permission (S4.12, S5.10) leaves its
// child alive with nothing in this file to end it. `edge/sse/index.test.ts` carries the
// same safety net for the same reason: reap whatever is still open, from the pid log
// `store` already writes, so an intentionally-stalled test does not outlive this process.
const storageRoots: string[] = [];

after(async () => {
  for (const root of storageRoots) {
    let log: string;
    try {
      log = await readFile(path.join(root, 'pids.ndjson'), 'utf8');
    } catch {
      continue;
    }
    for (const line of log.split('\n')) {
      if (line.trim() === '') continue;
      let record: { pid?: number; exitedAt?: string | null };
      try {
        record = JSON.parse(line) as typeof record;
      } catch {
        continue;
      }
      if (typeof record.pid !== 'number' || record.exitedAt) continue;
      try {
        process.kill(record.pid);
      } catch {
        // Already gone, which is the common case.
      }
    }
  }
});

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
  checkpointsOverride: ((config: Config) => Checkpoints) | null = null,
) {
  process.env['SKYNET_TEST_SCENARIO'] = scenario;
  process.env['SKYNET_CLAUDE_EXECUTABLE'] = FIXTURE;
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-sm-'));
  storageRoots.push(storageRoot);
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
  const checkpoints = (checkpointsOverride ?? createCheckpoints)(config);
  const manager = createSessionManager({
    config,
    store: wrapStore(storeResult.value),
    checkpoints,
    records: notImplementedProxy<Records>('records'),
  });
  return { manager, workspaceRoot, storageRoot, store: storeResult.value, checkpoints, config };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
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
  await waitUntil(async () => {
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Windows 8.3 short name for an entry inside `parentDir` — `dir /x`'s alias column,
// blank when the long name already fits 8.3 (S1.6, S5.7). `null` when it cannot be
// determined at all, which callers treat as "skip this case" rather than a failure.
async function shortNameFor(parentDir: string, entryName: string): Promise<string | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('cmd.exe', ['/c', 'dir', '/x', parentDir]));
  } catch {
    return null;
  }
  for (const line of stdout.split('\n')) {
    const idx = line.indexOf(entryName);
    if (idx === -1 || !line.includes('<DIR>')) continue;
    const before = line.slice(0, idx).trim();
    const token = before.split(/\s+/).pop();
    return token && token !== entryName ? token : null;
  }
  return null;
}

test('S5.1/S5.3/S5.4 — interrupt resolves an outstanding permission cancelled_process_exit, leaves the session live with no turn, and no-ops for a stale or absent turn', async () => {
  const { manager, workspaceRoot } = await makeManager('full');
  const owner = 'operator-1' as OperatorId;
  const projectDir = path.join(workspaceRoot, 'proj-s513');
  await mkdir(projectDir);
  const created = await manager.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const { sessionId } = created.value;

  // S5.3: no live turn at all — a no-op.
  const noopEarly = await manager.interrupt(sessionId, owner, 'not-a-real-turn' as never);
  assert.equal(noopEarly.ok, true);

  const received: Envelope[] = [];
  await manager.subscribe(sessionId, owner, 0, { deliver: (e) => received.push(e), close: () => {} });
  const messaged = await manager.message(sessionId, owner, 'go');
  assert.equal(messaged.ok, true);
  if (!messaged.ok) return;
  const { turnId } = messaged.value;

  await waitUntil(() => received.some((e) => e.kind === 'permission.request'));

  // S5.3: a turnId that does not name the live turn is also a no-op and emits nothing.
  const before = received.length;
  const staleResult = await manager.interrupt(sessionId, owner, 'some-other-turn' as never);
  assert.equal(staleResult.ok, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(received.length, before, 'a stale turnId emits nothing');

  const interrupted = await manager.interrupt(sessionId, owner, turnId);
  assert.equal(interrupted.ok, true);

  // S5.4: the outstanding permission.request resolves cancelled_process_exit.
  await waitUntil(() => received.some((e) => e.kind === 'permission.resolved'));
  const resolved = received.find((e) => e.kind === 'permission.resolved')!.data as { decision: string; reason: string };
  assert.equal(resolved.decision, 'deny');
  assert.equal(resolved.reason, 'cancelled_process_exit');

  // S5.1: the resulting turn.ended is an expected end, not a crash.
  await waitUntil(() => received.some((e) => e.kind === 'turn.ended'));
  const turnEnded = received.find((e) => e.kind === 'turn.ended')!;
  assert.equal((turnEnded.data as { stopReason: string }).stopReason, 'interrupted');

  const summary = manager.get(sessionId, owner);
  assert.equal(summary.ok, true);
  if (summary.ok) assert.equal(summary.value.state, 'live');

  // The turn slot is free again — a new message is not turn_in_flight.
  const again = await manager.message(sessionId, owner, 'go again');
  assert.equal(again.ok, true);
});

test('S5.2 — interrupt terminates the whole process tree: no live descendant five seconds after it returns, on this platform', async () => {
  const { manager, workspaceRoot } = await makeManager('grandchild');
  const owner = 'operator-1' as OperatorId;
  const projectDir = path.join(workspaceRoot, 'proj-s52');
  await mkdir(projectDir);
  const markerDir = await mkdtemp(path.join(tmpdir(), 'skynet-marker-'));
  const markerPath = path.join(markerDir, 'grandchild.json');
  process.env['SKYNET_GRANDCHILD_MARKER'] = markerPath;

  const created = await manager.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const { sessionId } = created.value;

  const received: Envelope[] = [];
  await manager.subscribe(sessionId, owner, 0, { deliver: (e) => received.push(e), close: () => {} });
  const messaged = await manager.message(sessionId, owner, 'go');
  assert.equal(messaged.ok, true);
  if (!messaged.ok) return;
  const { turnId } = messaged.value;

  let marker: { cliPid: number; grandchildPid: number } | null = null;
  await waitUntil(async () => {
    try {
      marker = JSON.parse(await readFile(markerPath, 'utf8')) as { cliPid: number; grandchildPid: number };
      return true;
    } catch {
      return false;
    }
  });
  assert.ok(marker, 'the fixture reported the pids it spawned');
  const { cliPid, grandchildPid } = marker!;
  assert.equal(isAlive(grandchildPid), true, 'the grandchild is actually running before interrupt');

  const interrupted = await manager.interrupt(sessionId, owner, turnId);
  assert.equal(interrupted.ok, true);

  await waitUntil(() => received.some((e) => e.kind === 'turn.ended'));

  // The route (here, `interrupt` itself) has already returned; the criterion measures
  // five seconds from that point, by real process enumeration against pids this test
  // spawned itself — D38, and `design/30-slices.md § What no slice covers` notes this
  // is verified per-platform until the two-platform CI gate (#28) exists to run both.
  await new Promise((r) => setTimeout(r, 5000));
  assert.equal(isAlive(cliPid), false, 'the CLI child is gone');
  assert.equal(isAlive(grandchildPid), false, 'the grandchild is gone too, not just the recorded pid');
});

test('S5.5/S5.6 — end sets ended, emits session.ended, refuses a further message, and frees the workspace', async () => {
  const { manager, workspaceRoot } = await makeManager('full');
  const owner = 'operator-1' as OperatorId;
  const projectDir = path.join(workspaceRoot, 'proj-s55');
  await mkdir(projectDir);
  const created = await manager.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const { sessionId } = created.value;

  // Busy before end.
  const secondCreate = await manager.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null });
  assert.equal(secondCreate.ok, false);
  if (!secondCreate.ok) assert.equal(secondCreate.error.code, 'workspace_busy');

  const received: Envelope[] = [];
  await manager.subscribe(sessionId, owner, 0, { deliver: (e) => received.push(e), close: () => {} });

  const ended = await manager.end(sessionId, owner);
  assert.equal(ended.ok, true);

  assert.ok(received.some((e) => e.kind === 'session.ended'));
  const endedEvent = received.find((e) => e.kind === 'session.ended')!.data as { reason: string };
  assert.equal(endedEvent.reason, 'operator');

  const summary = manager.get(sessionId, owner);
  assert.equal(summary.ok, true);
  if (summary.ok) {
    assert.equal(summary.value.state, 'ended');
    assert.notEqual(summary.value.endedAt, null);
  }

  const messaged = await manager.message(sessionId, owner, 'go');
  assert.equal(messaged.ok, false);
  if (!messaged.ok) assert.equal(messaged.error.code, 'session_ended');

  // Freed: a create at the exact same path now succeeds.
  const afterEnd = await manager.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null });
  assert.equal(afterEnd.ok, true);
});

test('S5.7 — the busy check tests overlap, not equality: a parent, a child, and a differently spelled version of a live session\'s cwd are each refused workspace_busy', async () => {
  const { manager, workspaceRoot } = await makeManager('full');
  const owner = 'operator-1' as OperatorId;
  const parentDir = path.join(workspaceRoot, 'proj-s57');
  const childDir = path.join(parentDir, 'nested', 'deeper');
  await mkdir(childDir, { recursive: true });

  const created = await manager.create(owner, { vendor: 'claude', cwd: parentDir, model: null, sandbox: null, requisitionId: null });
  assert.equal(created.ok, true);

  const cases: Array<[string, string]> = [
    ['a parent of the holder', workspaceRoot],
    ['a child of the holder', childDir],
    ['a trailing separator', parentDir + path.sep],
  ];
  if (process.platform === 'win32') cases.push(['a case variation', parentDir.toUpperCase()]);

  for (const [label, candidate] of cases) {
    const result = await manager.create(owner, { vendor: 'claude', cwd: candidate, model: null, sandbox: null, requisitionId: null });
    assert.equal(result.ok, false, label);
    if (!result.ok) {
      assert.equal(result.error.code, 'workspace_busy', label);
      if (result.error.code === 'workspace_busy') {
        assert.equal(result.error.holder.owner, owner, label);
      }
    }
  }
});

if (process.platform === 'win32') {
  test('S5.7 — a Windows 8.3 short name of a live session\'s cwd is also refused workspace_busy', async () => {
    const { manager, workspaceRoot } = await makeManager('full');
    const owner = 'operator-1' as OperatorId;
    const longName = 'a-fairly-long-directory-name-for-8dot3';
    const parentDir = path.join(workspaceRoot, longName);
    await mkdir(parentDir);

    const created = await manager.create(owner, { vendor: 'claude', cwd: parentDir, model: null, sandbox: null, requisitionId: null });
    assert.equal(created.ok, true);

    const shortName = await shortNameFor(workspaceRoot, longName);
    if (shortName === null) return; // could not determine one on this host; not this criterion's to diagnose

    const result = await manager.create(owner, { vendor: 'claude', cwd: path.join(workspaceRoot, shortName), model: null, sandbox: null, requisitionId: null });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'workspace_busy');
  });
}

test('S5.8 — the workspace claim and the turn slot are each claimed in the same synchronous block that tests them', async () => {
  const { manager, workspaceRoot } = await makeManager('full');
  const owner = 'operator-1' as OperatorId;
  const projectDir = path.join(workspaceRoot, 'proj-s58');
  await mkdir(projectDir);

  const [c1, c2] = await Promise.all([
    manager.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null }),
    manager.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null }),
  ]);
  assert.equal([c1, c2].filter((r) => r.ok).length, 1, 'exactly one create succeeded');
  const createFailure = [c1, c2].find((r) => !r.ok);
  if (createFailure && !createFailure.ok) assert.equal(createFailure.error.code, 'workspace_busy');

  const createSuccess = [c1, c2].find((r) => r.ok);
  if (!createSuccess || !createSuccess.ok) return;
  const { sessionId } = createSuccess.value;

  const [m1, m2] = await Promise.all([
    manager.message(sessionId, owner, 'a'),
    manager.message(sessionId, owner, 'b'),
  ]);
  assert.equal([m1, m2].filter((r) => r.ok).length, 1, 'exactly one message was accepted');
  const messageFailure = [m1, m2].find((r) => !r.ok);
  if (messageFailure && !messageFailure.ok) assert.equal(messageFailure.error.code, 'turn_in_flight');
});

test('S5.9 — delete removes meta.json, events.ndjson, tool-output/ and the registry entry, and leaves audit.ndjson byte-identical', async () => {
  const { manager, workspaceRoot, storageRoot } = await makeManager('full');
  const owner = 'operator-1' as OperatorId;
  const { sessionId, received, requestEnvelope } = await runOneRequest('full', workspaceRoot, manager, owner, 'proj-s59');
  const requestId = (requestEnvelope.data as { requestId: string }).requestId;
  await manager.answerPermission(sessionId, owner, { requestId: requestId as never, decision: 'allow', scope: 'once', rule: null, reason: null });
  await waitUntil(() => received.some((e) => e.kind === 'turn.ended'));

  const sessionDir = path.join(storageRoot, 'sessions', sessionId);
  assert.equal(existsSync(path.join(sessionDir, 'meta.json')), true);
  assert.equal(existsSync(path.join(sessionDir, 'events.ndjson')), true);
  assert.equal(existsSync(path.join(sessionDir, 'tool-output')), true);

  const auditBefore = await readFile(path.join(storageRoot, 'audit.ndjson'), 'utf8');

  // The turn slot frees only once turn.ended's durable write has landed, slightly after
  // the subscriber sees the envelope (S3.7's/S4.15's same race) — retry rather than
  // assert once.
  let removed;
  for (;;) {
    removed = await manager.remove(sessionId, owner);
    if (removed.ok) break;
    assert.equal(removed.error.code, 'turn_in_flight', `delete refused: ${removed.error.code}`);
    await new Promise((r) => setTimeout(r, 10));
  }

  assert.equal(existsSync(sessionDir), false);
  const got = manager.get(sessionId, owner);
  assert.equal(got.ok, false);
  if (!got.ok) assert.equal(got.error.code, 'no_such_session');

  const auditAfter = await readFile(path.join(storageRoot, 'audit.ndjson'), 'utf8');
  assert.equal(auditAfter, auditBefore);
});

test('S5.10 — end and delete are both refused turn_in_flight during a turn', async () => {
  const { manager, workspaceRoot } = await makeManager('full');
  const owner = 'operator-1' as OperatorId;
  const { sessionId } = await runOneRequest('full', workspaceRoot, manager, owner, 'proj-s510');

  const endResult = await manager.end(sessionId, owner);
  assert.equal(endResult.ok, false);
  if (!endResult.ok) assert.equal(endResult.error.code, 'turn_in_flight');

  const deleteResult = await manager.remove(sessionId, owner);
  assert.equal(deleteResult.ok, false);
  if (!deleteResult.ok) assert.equal(deleteResult.error.code, 'turn_in_flight');

  // Interrupt is the one operation allowed during a turn — exercised end-to-end by the
  // S5.1/S5.3/S5.4 test above, which interrupts a session with a live turn throughout.
});

test('S5.11 — a delete that fails part-way still removes the registry entry and emits a non-fatal notice naming what remains', async () => {
  const owner = 'operator-1' as OperatorId;
  const failingDeleteStore = (store: Store): Store => ({
    ...store,
    async deleteSession() {
      return { ok: false, error: { code: 'io', path: 'C:\\fake\\stuck-file', detail: 'boom' } };
    },
  });
  const { manager, workspaceRoot } = await makeManager('full', {}, failingDeleteStore);
  const projectDir = path.join(workspaceRoot, 'proj-s511');
  await mkdir(projectDir);
  const created = await manager.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const { sessionId } = created.value;

  const received: Envelope[] = [];
  await manager.subscribe(sessionId, owner, 0, { deliver: (e) => received.push(e), close: () => {} });

  const removed = await manager.remove(sessionId, owner);
  assert.equal(removed.ok, true, 'a storage failure does not become a 5xx; it is reported non-fatally');

  const got = manager.get(sessionId, owner);
  assert.equal(got.ok, false, 'the registry entry is gone regardless');

  const notice = received.find((e) => e.kind === 'error' && (e.data as { kind: string }).kind === 'session_delete_incomplete');
  assert.ok(notice, 'the still-open subscriber saw a session_delete_incomplete notice');
  const data = notice!.data as { fatal: boolean; message: string };
  assert.equal(data.fatal, false);
  assert.match(data.message, /stuck-file/);
});

// ---------------------------------------------------------------------------
// S6 — checkpoints
// ---------------------------------------------------------------------------

function wrapCheckpoints(over: Partial<Checkpoints>): (config: Config) => Checkpoints {
  return (config) => ({ ...createCheckpoints(config), ...over });
}

test('S6.2 - a pre-turn checkpoint.created precedes turn.started in seq order, and the checkpoint appears in listCheckpoints', async () => {
  const { manager, workspaceRoot } = await makeManager('full');
  const owner = 'operator-1' as OperatorId;
  const { sessionId, received, requestEnvelope } = await runOneRequest('full', workspaceRoot, manager, owner, 'proj-s62');
  const requestId = (requestEnvelope.data as { requestId: string }).requestId;
  await manager.answerPermission(sessionId, owner, { requestId: requestId as never, decision: 'allow', scope: 'once', rule: null, reason: null });
  await waitUntil(() => received.some((e) => e.kind === 'turn.ended'));

  const checkpointCreated = received.find((e) => e.kind === 'checkpoint.created');
  const turnStarted = received.find((e) => e.kind === 'turn.started');
  assert.ok(checkpointCreated, 'a checkpoint.created envelope was emitted');
  assert.ok(turnStarted, 'a turn.started envelope was emitted');
  assert.ok(checkpointCreated!.seq < turnStarted!.seq, 'checkpoint.created precedes turn.started in seq order');
  const data = checkpointCreated!.data as { turnId: string | null; sha: string; label: string };
  assert.notEqual(data.turnId, null, "a pre-turn checkpoint's turnId is not null (only a restore's safety checkpoint is)");

  const listed = await manager.listCheckpoints(sessionId, owner);
  assert.equal(listed.ok, true);
  if (listed.ok) assert.ok(listed.value.some((c) => c.sha === data.sha && c.label === data.label));
});

test('S6.4/S6.5 - restore commits a safety checkpoint (turnId null), is refused turn_in_flight mid-turn, and an unknown sha is no_such_checkpoint', async () => {
  const { manager, workspaceRoot } = await makeManager('full');
  const owner = 'operator-1' as OperatorId;
  const { sessionId, received, requestEnvelope } = await runOneRequest('full', workspaceRoot, manager, owner, 'proj-s64');
  const requestId = (requestEnvelope.data as { requestId: string }).requestId;

  // S6.5: refused while the turn from runOneRequest is still live and unanswered.
  const duringTurn = await manager.restore(sessionId, owner, 'deadbeef'.repeat(5) as never);
  assert.equal(duringTurn.ok, false);
  if (!duringTurn.ok) assert.equal(duringTurn.error.code, 'turn_in_flight');

  await manager.answerPermission(sessionId, owner, { requestId: requestId as never, decision: 'allow', scope: 'once', rule: null, reason: null });
  await waitUntil(() => received.some((e) => e.kind === 'turn.ended'));

  // S6.5: an unknown sha, once no turn is running. The turn slot frees only once
  // turn.ended's durable write has landed, slightly after the subscriber sees the
  // envelope (the same S3.7/S4.15/S5.9 race) — retry rather than assert once.
  let bogus;
  for (;;) {
    bogus = await manager.restore(sessionId, owner, '0'.repeat(40) as never);
    if (!bogus.ok && bogus.error.code === 'turn_in_flight') {
      await new Promise((r) => setTimeout(r, 10));
      continue;
    }
    break;
  }
  assert.equal(bogus.ok, false);
  if (!bogus.ok) {
    assert.equal(bogus.error.code, 'checkpoint');
    if (bogus.error.code === 'checkpoint') assert.equal(bogus.error.cause.code, 'no_such_checkpoint');
  }

  // S6.4: restoring to the real pre-turn checkpoint succeeds and announces the safety
  // checkpoint with turnId: null.
  const checkpointCreated = received.find((e) => e.kind === 'checkpoint.created')!;
  const target = (checkpointCreated.data as { sha: string }).sha;
  let restored;
  for (;;) {
    restored = await manager.restore(sessionId, owner, target as never);
    if (!restored.ok && restored.error.code === 'turn_in_flight') {
      await new Promise((r) => setTimeout(r, 10));
      continue;
    }
    break;
  }
  assert.equal(restored.ok, true);

  await waitUntil(() => received.filter((e) => e.kind === 'checkpoint.created').length >= 2);
  const safety = received.filter((e) => e.kind === 'checkpoint.created')[1]!;
  const safetyData = safety.data as { turnId: string | null; sha: string; label: string };
  assert.equal(safetyData.turnId, null, "the safety checkpoint's turnId is null (D31)");
  assert.match(safetyData.label, /before restore to/);

  const listed = await manager.listCheckpoints(sessionId, owner);
  assert.equal(listed.ok, true);
  if (listed.ok) assert.ok(listed.value.some((c) => c.sha === safetyData.sha));
});

test('S6.8 - a ckpt.git that cannot be initialised yields session.notice/warn checkpoints_unavailable, and the session is created and usable', async () => {
  const owner = 'operator-1' as OperatorId;
  const { manager, workspaceRoot } = await makeManager(
    'full',
    {},
    (s) => s,
    (config) => wrapCheckpoints({ init: async () => ({ ok: false, error: { code: 'init_failed', detail: 'simulated: disk full' } }) })(config),
  );
  const projectDir = path.join(workspaceRoot, 'proj-s68');
  await mkdir(projectDir);
  const received: Envelope[] = [];
  const created = await manager.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  await manager.subscribe(created.value.sessionId, owner, 0, { deliver: (e) => received.push(e), close: () => {} });

  const notice = received.find((e) => e.kind === 'session.notice' && (e.data as { code: string }).code === 'checkpoints_unavailable');
  assert.ok(notice, 'checkpoints_unavailable was announced');
  assert.equal((notice!.data as { level: string }).level, 'warn');

  // The session is still usable: a message still runs a turn.
  const messaged = await manager.message(created.value.sessionId, owner, 'go');
  assert.equal(messaged.ok, true, 'the session is created and usable without checkpoints');
});

test('S6.9 - a pre-turn checkpoint that fails yields session.notice/warn checkpoint_skipped naming ckpt.git/index.lock, and the turn proceeds', async () => {
  const owner = 'operator-1' as OperatorId;
  const { manager, workspaceRoot } = await makeManager(
    'full',
    {},
    (s) => s,
    (config) =>
      wrapCheckpoints({
        commit: async () => ({ ok: false, error: { code: 'locked', detail: 'ckpt.git/index.lock exists - git said: simulated' } }),
      })(config),
  );
  const { sessionId, received, requestEnvelope } = await runOneRequest('full', workspaceRoot, manager, owner, 'proj-s69');
  const requestId = (requestEnvelope.data as { requestId: string }).requestId;
  await manager.answerPermission(sessionId, owner, { requestId: requestId as never, decision: 'allow', scope: 'once', rule: null, reason: null });
  await waitUntil(() => received.some((e) => e.kind === 'turn.ended'));

  const notice = received.find((e) => e.kind === 'session.notice' && (e.data as { code: string }).code === 'checkpoint_skipped');
  assert.ok(notice, 'checkpoint_skipped was announced');
  assert.equal((notice!.data as { level: string }).level, 'warn');
  assert.match((notice!.data as { text: string }).text, /ckpt\.git\/index\.lock/);
  assert.equal(received.some((e) => e.kind === 'checkpoint.created'), false, 'no checkpoint.created for a failed commit');
  const ended = received.find((e) => e.kind === 'turn.ended');
  assert.ok(ended);
});

test('S6.10 - DELETE also removes ckpt.git', async () => {
  const owner = 'operator-1' as OperatorId;
  const { manager, workspaceRoot, storageRoot } = await makeManager('full');
  const projectDir = path.join(workspaceRoot, 'proj-s610');
  await mkdir(projectDir);
  const created = await manager.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const gitDir = path.join(storageRoot, 'sessions', created.value.sessionId, 'ckpt.git');
  assert.equal(existsSync(gitDir), true, 'ckpt.git exists after create');

  const removed = await manager.remove(created.value.sessionId, owner);
  assert.equal(removed.ok, true);
  assert.equal(existsSync(gitDir), false, 'ckpt.git is gone after delete');
});

// --- S7 — Survive a restart -------------------------------------------------------

// Processes deliberately left running by a "not reaped" test (S7.6) — the module-level
// safety net at the top of this file only kills what `pids.ndjson` still calls open, and
// a correctly-declined reap tombstones the entry precisely because it left the process
// alone, so that net would miss it.
const strayPids: number[] = [];
after(() => {
  for (const pid of strayPids) {
    try {
      process.kill(pid);
    } catch {
      // Already gone.
    }
  }
});

// A hand-built `SessionRecord`, bypassing `session-manager`/the adapter entirely — S7's
// rehydration path only ever reads what `store` already wrote, so a fixture built
// straight against `store` exercises exactly that contract without needing a real turn.
function bootSessionRecord(id: string, overrides: Partial<import('../contract/index.js').SessionRecord> = {}): import('../contract/index.js').SessionRecord {
  return {
    id: id as SessionId,
    owner: 'operator-1' as OperatorId,
    vendor: 'claude',
    cwd: 'C:\\workspace\\proj' as never,
    model: null,
    policy: { mode: 'interactive', sandbox: null, banner: null },
    sandbox: null,
    cliSessionId: null,
    lastSeq: 0 as never,
    state: 'live',
    createdAt: new Date().toISOString() as IsoTimestamp,
    endedAt: null,
    ...overrides,
  };
}

function bootEnvelope(sessionId: string, seq: number, kind: string, data: unknown): Envelope {
  return {
    seq: seq as never,
    sessionId: sessionId as never,
    ts: new Date().toISOString() as never,
    kind: kind as never,
    data: data as never,
  } as Envelope;
}

// A real process tree — a parent that spawns one grandchild in its own group (POSIX) or
// under it in the live process table (Windows) — for exercising the tree-kill half of
// the reuse guard (S7.5, S7.6), independent of the adapter's own copy of the same
// mechanism (already covered by S5.2).
async function spawnTrackedTree(): Promise<{ pid: number; pgid: number | null; grandchildPid: number }> {
  const markerDir = await mkdtemp(path.join(tmpdir(), 'skynet-s7-marker-'));
  const markerPath = path.join(markerDir, 'gc.json');
  const script =
    "const { spawn } = require('node:child_process'); const fs = require('node:fs'); " +
    "const gc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' }); gc.unref(); " +
    `fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ grandchildPid: gc.pid })); ` +
    'setTimeout(() => {}, 120000);';
  const parent = spawn(process.execPath, ['-e', script], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  parent.unref();
  await waitUntil(() => existsSync(markerPath));
  const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { grandchildPid: number };
  return {
    pid: parent.pid!,
    pgid: process.platform === 'win32' ? null : (parent.pid ?? null),
    grandchildPid: marker.grandchildPid,
  };
}

test('S7.1 — boot runs reap, then rehydrate, in that order, and does not resolve until both finish', async () => {
  const order: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wrapStore = (store: Store): Store => ({
    ...store,
    async readOpenPids() {
      order.push('readOpenPids:start');
      await gate;
      order.push('readOpenPids:end');
      return store.readOpenPids();
    },
    async readAllMeta() {
      order.push('readAllMeta');
      return store.readAllMeta();
    },
  });
  const { manager } = await makeManager('full', {}, wrapStore);

  const bootPromise = manager.boot();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(order, ['readOpenPids:start'], 'rehydration has not started while reap is still in flight');

  release();
  const booted = await bootPromise;
  assert.equal(booted.ok, true);
  assert.deepEqual(order, ['readOpenPids:start', 'readOpenPids:end', 'readAllMeta']);
  // `server.ts` awaits `manager.boot()` before calling `server.listen()` (unchanged by
  // this slice) — this is the ordering that makes a connection during rehydration
  // impossible at the system level; this test proves the internal step order it depends on.
});

test('S7.2/S7.3 — a rehydrated session is ended with endedAt set and lastSeq derived from the spill, not a stale meta.json value; a message to it is refused session_ended', async () => {
  const { config, store, checkpoints } = await makeManager('full');
  const sessionId = 'sess-rehydrate-1';
  const record = bootSessionRecord(sessionId);
  assert.equal((await store.createSession(record)).ok, true);
  for (let seq = 1; seq <= 5; seq++) {
    assert.equal((await store.appendEvent(record.id, bootEnvelope(sessionId, seq, 'message', { turnId: 't1', role: 'user', text: `m${seq}` }))).ok, true);
  }
  // S7.3: meta.json's own lastSeq is deliberately wrong.
  await store.writeMeta({ ...record, lastSeq: 99999 as never });

  const manager2 = createSessionManager({ config, store, checkpoints, records: notImplementedProxy<Records>('records') });
  const booted = await manager2.boot();
  assert.equal(booted.ok, true);

  const got = manager2.get(sessionId as never, record.owner);
  assert.equal(got.ok, true);
  if (got.ok) {
    assert.equal(got.value.state, 'ended');
    assert.notEqual(got.value.endedAt, null);
    assert.equal(got.value.lastSeq, 5, 'lastSeq follows the spill, not the stale meta.json value');
  }

  const messaged = await manager2.message(sessionId as never, record.owner, 'hello');
  assert.equal(messaged.ok, false);
  if (!messaged.ok) assert.equal(messaged.error.code, 'session_ended');
});

test('S7.2/S7.3 follow-up — restore(), interrupt(), and a repeat end() on a rehydrated session are refused/no-op rather than touching its null adapter', async () => {
  const { config, store, checkpoints } = await makeManager('full');
  const sessionId = 'sess-rehydrate-2';
  const record = bootSessionRecord(sessionId);
  assert.equal((await store.createSession(record)).ok, true);
  assert.equal((await store.appendEvent(record.id, bootEnvelope(sessionId, 1, 'message', { turnId: 't1', role: 'user', text: 'm1' }))).ok, true);

  const manager2 = createSessionManager({ config, store, checkpoints, records: notImplementedProxy<Records>('records') });
  assert.equal((await manager2.boot()).ok, true);

  const before = manager2.get(sessionId as never, record.owner);
  assert.equal(before.ok, true);
  const endedAtBefore = before.ok ? before.value.endedAt : null;

  const restored = await manager2.restore(sessionId as never, record.owner, 'deadbeef' as never);
  assert.equal(restored.ok, false);
  if (!restored.ok) assert.equal(restored.error.code, 'session_ended', 'restore does not run checkpoints.restore against a cwd this entry no longer owns');

  const interrupted = await manager2.interrupt(sessionId as never, record.owner, 't1' as never);
  assert.equal(interrupted.ok, true, 'no live turn to interrupt is a no-op, not an error');

  const ended = await manager2.end(sessionId as never, record.owner);
  assert.equal(ended.ok, true, 'ending an already-ended session is a no-op, not an error');

  const after = manager2.get(sessionId as never, record.owner);
  assert.equal(after.ok, true);
  if (after.ok) {
    assert.equal(after.value.endedAt, endedAtBefore, 'endedAt is not clobbered by a repeat end()');
    assert.equal(after.value.lastSeq, before.ok ? before.value.lastSeq : -1, 'no duplicate session.ended was appended');
  }
});

test('S7.4 — a spill ending on an unpaired turn.started is closed at boot: outstanding permission.requests resolve cancelled_process_exit, then turn.ended/server_restart, at the next contiguous seq', async () => {
  const { config, store, checkpoints, storageRoot } = await makeManager('full');
  const sessionId = 'sess-crash-1';
  const record = bootSessionRecord(sessionId);
  assert.equal((await store.createSession(record)).ok, true);

  const turnId = 't-crash';
  let seq = 0;
  const append = async (kind: string, data: unknown) => {
    seq += 1;
    assert.equal((await store.appendEvent(record.id, bootEnvelope(sessionId, seq, kind, data))).ok, true);
  };
  await append('turn.started', { turnId });
  await append('permission.request', { turnId, requestId: 'req-1', callId: 'call-1', tool: 'Bash', input: { cmd: 'ls' }, suggestions: [] });
  await append('permission.request', { turnId, requestId: 'req-2', callId: 'call-2', tool: 'Write', input: { path: 'x' }, suggestions: [] });
  // No turn.ended written — this is the crash.

  const manager2 = createSessionManager({ config, store, checkpoints, records: notImplementedProxy<Records>('records') });
  const booted = await manager2.boot();
  assert.equal(booted.ok, true);

  const replayed: Envelope[] = [];
  await manager2.subscribe(sessionId as never, record.owner, 0, { deliver: (e) => replayed.push(e), close: () => {} });

  const seqs = replayed.map((e) => e.seq as unknown as number);
  for (let i = 1; i < seqs.length; i++) assert.equal(seqs[i], seqs[i - 1]! + 1, 'contiguous seq, continuing from where the spill left off');

  const kinds = replayed.map((e) => e.kind);
  assert.deepEqual(kinds, ['turn.started', 'permission.request', 'permission.request', 'permission.resolved', 'permission.resolved', 'turn.ended']);

  const resolved = replayed.filter((e) => e.kind === 'permission.resolved');
  for (const r of resolved) {
    const d = r.data as { reason: string; decision: string; operator: unknown; turnId: string };
    assert.equal(d.reason, 'cancelled_process_exit');
    assert.equal(d.decision, 'deny');
    assert.equal(d.operator, null);
    assert.equal(d.turnId, turnId);
  }

  const ended = replayed.find((e) => e.kind === 'turn.ended')!;
  const endedData = ended.data as { stopReason: string; turnId: string };
  assert.equal(endedData.stopReason, 'server_restart');
  assert.equal(endedData.turnId, turnId);

  const auditRecords = await readAudit(storageRoot);
  const forThisSession = auditRecords.filter((r) => r.sessionId === (sessionId as never));
  assert.equal(forThisSession.length, 2);
  for (const a of forThisSession) {
    assert.equal(a.decision, 'deny');
    assert.equal(a.reason, 'cancelled_process_exit');
    assert.equal(a.operator, null);
  }
});

test('S7.7 — a meta.json that fails to parse, or carries an unknown schemaVersion, is skipped and logged; boot continues to serve every other session', async () => {
  const { config, store, checkpoints, storageRoot } = await makeManager('full');

  const good = bootSessionRecord('sess-good');
  assert.equal((await store.createSession(good)).ok, true);

  const corrupt = bootSessionRecord('sess-corrupt');
  assert.equal((await store.createSession(corrupt)).ok, true);
  await writeFile(path.join(storageRoot, 'sessions', 'sess-corrupt', 'meta.json'), '{ not json');

  const future = bootSessionRecord('sess-future');
  assert.equal((await store.createSession(future)).ok, true);
  await writeFile(path.join(storageRoot, 'sessions', 'sess-future', 'meta.json'), JSON.stringify({ schemaVersion: 99, session: future }));

  const manager2 = createSessionManager({ config, store, checkpoints, records: notImplementedProxy<Records>('records') });
  const booted = await manager2.boot();
  assert.equal(booted.ok, true);

  const goodGot = manager2.get('sess-good' as never, good.owner);
  assert.equal(goodGot.ok, true);
  if (goodGot.ok) assert.equal(goodGot.value.state, 'ended');

  assert.equal(manager2.get('sess-corrupt' as never, corrupt.owner).ok, false);
  assert.equal(manager2.get('sess-future' as never, future.owner).ok, false);

  // Left untouched, for inspection.
  const corruptRaw = await readFile(path.join(storageRoot, 'sessions', 'sess-corrupt', 'meta.json'), 'utf8');
  assert.equal(corruptRaw, '{ not json');
});

test('S7.8 — a rehydrated session does not hold its workspace: a new session on the same path is created after a restart', async () => {
  const { manager: manager1, config, store, checkpoints, workspaceRoot } = await makeManager('full');
  const owner = 'operator-1' as OperatorId;
  const projectDir = path.join(workspaceRoot, 'reclaim-me');
  await mkdir(projectDir);
  const created = await manager1.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const manager2 = createSessionManager({ config, store, checkpoints, records: notImplementedProxy<Records>('records') });
  assert.equal((await manager2.boot()).ok, true);

  const createdAgain = await manager2.create(owner, { vendor: 'claude', cwd: projectDir, model: null, sandbox: null, requisitionId: null });
  assert.equal(createdAgain.ok, true);
});

test('S7.9 — pids.ndjson gains one line per spawn and one tombstone per exit; the latest line for a pid wins', async () => {
  const { store, storageRoot } = await makeManager('full');
  const pid = 999001; // synthetic: nothing is actually spawned for this test
  const record: ProcessRecord = {
    pid,
    pgid: null,
    sessionId: 'sess-s79' as SessionId,
    turnId: 'turn-s79' as TurnId,
    startedAt: new Date().toISOString() as IsoTimestamp,
    image: 'whatever',
    exitedAt: null,
  };
  assert.equal((await store.appendPid(record)).ok, true);
  assert.equal((await store.readOpenPids()).some((r) => r.pid === pid), true);

  assert.equal((await store.tombstonePid(pid, new Date().toISOString() as IsoTimestamp)).ok, true);
  assert.equal((await store.readOpenPids()).some((r) => r.pid === pid), false);

  const raw = await readFile(path.join(storageRoot, 'pids.ndjson'), 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  assert.equal(lines.length, 2, 'one spawn line, one tombstone line');
});

test('S7.5 — a live process whose recorded image matches and started after the host boot is reaped: the whole tree is killed and the entry tombstoned', async () => {
  const { manager, store } = await makeManager('full');
  const { pid, pgid, grandchildPid } = await spawnTrackedTree();
  strayPids.push(pid, grandchildPid);
  assert.equal(isAlive(pid), true, 'the parent is running before boot');
  assert.equal(isAlive(grandchildPid), true, 'the grandchild is running before boot');

  const record: ProcessRecord = {
    pid,
    pgid,
    sessionId: 'sess-reap-s75' as SessionId,
    turnId: 'turn-reap-s75' as TurnId,
    startedAt: new Date().toISOString() as IsoTimestamp,
    image: path.basename(process.execPath).replace(/\.exe$/i, ''),
    exitedAt: null,
  };
  assert.equal((await store.appendPid(record)).ok, true);

  const booted = await manager.boot();
  assert.equal(booted.ok, true);

  await waitUntil(() => !isAlive(pid) && !isAlive(grandchildPid), 5000);

  const open = await store.readOpenPids();
  assert.equal(open.some((r) => r.pid === pid), false, 'the reaped entry is tombstoned');
});

test('S7.6 — a live process whose image does not match the record is not reaped: it is logged and tombstoned, and left running', async () => {
  const { manager, store } = await makeManager('full');
  const { pid, pgid, grandchildPid } = await spawnTrackedTree();
  strayPids.push(pid, grandchildPid);

  const record: ProcessRecord = {
    pid,
    pgid,
    sessionId: 'sess-reap-s76' as SessionId,
    turnId: 'turn-reap-s76' as TurnId,
    startedAt: new Date().toISOString() as IsoTimestamp,
    image: 'definitely-not-the-real-image',
    exitedAt: null,
  };
  assert.equal((await store.appendPid(record)).ok, true);

  const booted = await manager.boot();
  assert.equal(booted.ok, true);

  // The (correctly declined) reap gets time it does not need, so a false-positive kill
  // would have had time to land.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(isAlive(pid), true, 'a wrong kill is an incident, so the process was left alone');

  const open = await store.readOpenPids();
  assert.equal(open.some((r) => r.pid === pid), false, 'still tombstoned even though not killed, so this is a one-time bookkeeping event, not a permanent stall');
});

test('S7.10 — a storage root that cannot be written at boot refuses to start with StartupError.storage_unwritable', async () => {
  const { manager, storageRoot } = await makeManager('full');
  await rm(storageRoot, { recursive: true, force: true });

  const booted = await manager.boot();
  assert.equal(booted.ok, false);
  if (!booted.ok) assert.equal(booted.error.code, 'storage_unwritable');
});
