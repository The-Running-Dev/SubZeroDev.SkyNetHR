import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
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

async function makeManager(scenario: string) {
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
  return { manager, workspaceRoot };
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

test('S1.6/S1.7 (session-manager integration) — a cwd outside every root is refused before any session is created', async () => {
  const { manager } = await makeManager('full');
  const owner = 'operator-1' as OperatorId;
  const outside = await mkdtemp(path.join(tmpdir(), 'skynet-outside-'));
  const result = await manager.create(owner, { vendor: 'claude', cwd: outside, model: null, sandbox: null, requisitionId: null });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'jail');
});
