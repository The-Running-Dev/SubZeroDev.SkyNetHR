#!/usr/bin/env node
// S26.10 — real-binary check of the ordering guarantees over a run with at least three
// permission requests, plus a double-answer on the first one to assert exactly-one-
// resolution against the real child (not only the fixture, which S4.5/D33 already cover).
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSessionManager } from '../dist/session-manager/index.js';
import { createStore } from '../dist/store/index.js';
import { createCheckpoints } from '../dist/checkpoints/index.js';

const [, , workspaceArg] = process.argv;
if (!workspaceArg) { console.error('usage: node harness/run-s26-multi.mjs <workspace-dir>'); process.exit(1); }

const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-harness-s26multi-'));
const config = {
  bind: { host: '127.0.0.1', port: 3000 },
  auth: { mode: 'shared-secret', cookieName: 'skynet', secret: 'harness' },
  workspaceRoots: [path.resolve(workspaceArg)],
  storageRoot,
  allowedOrigins: [],
  trustProxy: [],
  caps: { ringCapacity: 500, toolResultBytes: 65536, subscriberQueueHighWater: 1000, keepaliveMs: 15000, auditPageMax: 200, reviewBodyBytes: 1024, requisitionTextBytes: 1024 },
  includeRaw: false,
  sessionTokenBudget: null,
  checklist: [],
};

const storeResult = await createStore(config);
if (!storeResult.ok) { console.error('store init failed', storeResult.error); process.exit(1); }
const manager = createSessionManager({ config, store: storeResult.value, checkpoints: createCheckpoints(config), records: undefined });

const owner = 'harness-operator';
const created = await manager.create(owner, { vendor: 'claude', cwd: workspaceArg, model: null, sandbox: null, requisitionId: null });
if (!created.ok) { console.error('create failed', created.error); process.exit(1); }
const { sessionId } = created.value;
console.log(`session ${sessionId} created`);

let ended = false;
const requestIds = [];
let doubleAnswerSecondResult = null;
await manager.subscribe(sessionId, owner, 0, {
  deliver: async (envelope) => {
    console.log(`[seq ${envelope.seq}] ${envelope.kind}`, JSON.stringify(envelope.data));
    if (envelope.kind === 'permission.request') {
      const requestId = envelope.data.requestId;
      requestIds.push(requestId);
      const answered = await manager.answerPermission(sessionId, owner, { requestId, decision: 'allow', scope: 'once', rule: null, reason: `harness allow #${requestIds.length}` });
      if (!answered.ok) console.error('  answerPermission failed', answered.error);
      // Only on the FIRST request: immediately fire a second answer to the same
      // requestId, to assert exactly-one-resolution against the real child.
      if (requestIds.length === 1) {
        doubleAnswerSecondResult = await manager.answerPermission(sessionId, owner, { requestId, decision: 'deny', scope: 'once', rule: null, reason: 'harness double-answer attempt' });
      }
    }
    if (envelope.kind === 'turn.ended') ended = true;
  },
  close: () => {},
});

const messaged = await manager.message(
  sessionId, owner,
  'Run these three separate bash commands, one at a time, each as its own tool call: (1) echo marker-one > one.txt (2) echo marker-two > two.txt (3) echo marker-three > three.txt',
  [],
);
if (!messaged.ok) { console.error('message failed', messaged.error); process.exit(1); }

const start = Date.now();
while (!ended) {
  if (Date.now() - start > 180000) { console.error('timed out'); process.exit(1); }
  await new Promise((r) => setTimeout(r, 100));
}
console.log(`turn.ended reached. requestIds seen: ${requestIds.length}`);
console.log(`double-answer second call result:`, JSON.stringify(doubleAnswerSecondResult));

const audit = await readFile(path.join(storageRoot, 'audit.ndjson'), 'utf8').catch((e) => `<no audit: ${e.message}>`);
console.log('--- audit.ndjson ---');
console.log(audit);
