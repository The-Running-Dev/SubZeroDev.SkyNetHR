#!/usr/bin/env node
// Throwaway harness for S26.8/S26.10 (design/30-slices.md § S26) — not shipped. Same
// shape as harness/run.mjs, but the permission decision is a CLI argument so both allow
// and deny can be round-tripped to a real `claude` child, and it prints the audit record
// written for each resolution so the fsync-before-response and one-resolution-per-request
// guarantees can be inspected from real output rather than only from the fixture suite.
//
// Usage: node harness/run-s26.mjs <workspace-dir> <allow|deny> "<message text>"

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSessionManager } from '../dist/session-manager/index.js';
import { createStore } from '../dist/store/index.js';
import { createCheckpoints } from '../dist/checkpoints/index.js';

const [, , workspaceArg, decisionArg, ...messageParts] = process.argv;
if (!workspaceArg || !['allow', 'deny'].includes(decisionArg)) {
  console.error('usage: node harness/run-s26.mjs <workspace-dir> <allow|deny> "<message text>"');
  process.exit(1);
}
const text = messageParts.join(' ') || 'Run the bash command: echo s26-harness-marker';

const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-harness-s26-'));
const config = {
  bind: { host: '127.0.0.1', port: 3000 },
  auth: { mode: 'shared-secret', cookieName: 'skynet', secret: 'harness' },
  workspaceRoots: [path.resolve(workspaceArg)],
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
if (!storeResult.ok) {
  console.error('store init failed', storeResult.error);
  process.exit(1);
}

const manager = createSessionManager({
  config,
  store: storeResult.value,
  checkpoints: createCheckpoints(config),
  records: undefined,
});

const owner = 'harness-operator';
const created = await manager.create(owner, {
  vendor: 'claude',
  cwd: workspaceArg,
  model: null,
  sandbox: null,
  requisitionId: null,
});
if (!created.ok) {
  console.error('create failed', created.error);
  process.exit(1);
}
const { sessionId } = created.value;
console.log(`session ${sessionId} created against ${workspaceArg}, decision=${decisionArg}`);

let ended = false;
let sawPermissionRequest = false;
await manager.subscribe(sessionId, owner, 0, {
  deliver: async (envelope) => {
    console.log(`[seq ${envelope.seq}] ${envelope.kind}`, JSON.stringify(envelope.data));
    if (envelope.kind === 'permission.request') {
      sawPermissionRequest = true;
      const requestId = envelope.data.requestId;
      console.log(`  answering permission.request ${requestId} with ${decisionArg}`);
      const answered = await manager.answerPermission(sessionId, owner, {
        requestId,
        decision: decisionArg,
        scope: 'once',
        rule: null,
        reason: `harness ${decisionArg} (S26.8)`,
      });
      if (!answered.ok) console.error('  answerPermission failed', answered.error);
    }
    if (envelope.kind === 'turn.ended') ended = true;
  },
  close: () => {},
});

const messaged = await manager.message(sessionId, owner, text, []);
if (!messaged.ok) {
  console.error('message failed', messaged.error);
  process.exit(1);
}

const start = Date.now();
while (!ended) {
  if (Date.now() - start > 120000) {
    console.error('timed out waiting for turn.ended');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 100));
}
console.log(`turn.ended reached; sawPermissionRequest=${sawPermissionRequest}`);

const auditPath = path.join(storageRoot, 'audit.ndjson');
try {
  const audit = await readFile(auditPath, 'utf8');
  console.log('--- audit.ndjson ---');
  console.log(audit);
} catch (err) {
  console.log(`no audit.ndjson at ${auditPath}: ${err.message}`);
}
