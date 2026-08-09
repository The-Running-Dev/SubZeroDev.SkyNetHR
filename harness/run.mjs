#!/usr/bin/env node
// Throwaway CLI harness for S1 (design/30-slices.md § S1) — not shipped. Drives one
// session manager, in-process, against a real `claude` child: creates a session in the
// given workspace, sends one message, prints every envelope as it arrives, and
// auto-denies any permission request so the turn can still reach `turn.ended` without a
// browser (S1.9). Requires `npm run build` first.
//
// Usage: node harness/run.mjs <workspace-dir> "<message text>"

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSessionManager } from '../dist/session-manager/index.js';
import { createStore } from '../dist/store/index.js';

const [, , workspaceArg, ...messageParts] = process.argv;
if (!workspaceArg) {
  console.error('usage: node harness/run.mjs <workspace-dir> "<message text>"');
  process.exit(1);
}
const text = messageParts.join(' ') || 'Say hello in one short sentence.';

const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-harness-'));
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
  checkpoints: undefined, // not called by S1's flow
  records: undefined, // not called by S1's flow
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
console.log(`session ${sessionId} created against ${workspaceArg}`);

let ended = false;
await manager.subscribe(sessionId, owner, 0, {
  deliver: async (envelope) => {
    console.log(`[seq ${envelope.seq}] ${envelope.kind}`, JSON.stringify(envelope.data));
    if (envelope.kind === 'permission.request') {
      const requestId = envelope.data.requestId;
      console.log(`  auto-denying permission.request ${requestId}`);
      const answered = await manager.answerPermission(sessionId, owner, {
        requestId,
        decision: 'deny',
        scope: 'once',
        rule: null,
        reason: 'harness auto-deny (S1.9)',
      });
      if (!answered.ok) console.error('  answerPermission failed', answered.error);
    }
    if (envelope.kind === 'turn.ended') ended = true;
  },
  close: () => {},
});

const messaged = await manager.message(sessionId, owner, text);
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
console.log('turn.ended reached; exiting.');
