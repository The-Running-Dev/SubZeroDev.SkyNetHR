import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRecords } from './index.js';
import { createStore } from '../store/index.js';
import type { Config, OperatorId, Store } from '../contract/index.js';

function baseConfig(storageRoot: string, requisitionTextBytes = 1024): Config {
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
      requisitionTextBytes,
      standingRuleBytes: 1024,
    },
    sessionCookieMaxAgeSeconds: 2592000,
    includeRaw: false,
    sessionTokenBudget: null,
    checklist: [],
    edge: 'sse',
  };
}

async function makeStore(config: Config): Promise<Store> {
  const created = await createStore(config);
  if (!created.ok) throw new Error('store failed to init');
  return created.value;
}

const OP1 = 'op-1' as OperatorId;
const OP2 = 'op-2' as OperatorId;

test('S13.2 — raise stores workspace unresolved, in state open, with no jail call', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-rec-'));
  const config = baseConfig(storageRoot);
  const store = await makeStore(config);
  const records = createRecords({ config, store });

  const raised = await records.raise(OP1, { title: 't', justification: 'j', workspace: '/definitely/outside/every/root', vendor: 'claude' });
  assert.equal(raised.ok, true);
  if (!raised.ok) return;
  assert.equal(raised.value.state, 'open');
  assert.equal(raised.value.workspace, '/definitely/outside/every/root');
  assert.equal(raised.value.raisedBy, OP1);
  assert.equal(raised.value.decidedBy, null);
  assert.equal(raised.value.sessionId, null);
});

test('S13.3 — listRequisitions returns every requisition to every operator', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-rec-'));
  const config = baseConfig(storageRoot);
  const store = await makeStore(config);
  const records = createRecords({ config, store });

  await records.raise(OP1, { title: 'a', justification: 'j', workspace: '/w1', vendor: 'claude' });
  await records.raise(OP2, { title: 'b', justification: 'j', workspace: '/w2', vendor: 'codex' });

  const listed = records.listRequisitions();
  assert.equal(listed.length, 2);
});

test('S13.4 — decide moves open to approved or rejected, and a second decision is already_decided naming the decider and state', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-rec-'));
  const config = baseConfig(storageRoot);
  const store = await makeStore(config);
  const records = createRecords({ config, store });

  const raised = await records.raise(OP1, { title: 't', justification: 'j', workspace: '/w', vendor: 'claude' });
  assert.equal(raised.ok, true);
  if (!raised.ok) return;

  const decided = await records.decide(raised.value.requisitionId, OP2, 'approve');
  assert.equal(decided.ok, true);
  if (decided.ok) {
    assert.equal(decided.value.state, 'approved');
    assert.equal(decided.value.decidedBy, OP2);
    assert.ok(decided.value.decidedAt !== null);
  }

  const second = await records.decide(raised.value.requisitionId, OP1, 'reject');
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.error.code, 'already_decided');
    if (second.error.code === 'already_decided') {
      assert.equal(second.error.decidedBy, OP2);
      assert.equal(second.error.state, 'approved');
    }
  }
});

test('S13.4/I5 — two decisions dispatched in the same tick yield exactly one 200 and one 409', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-rec-'));
  const config = baseConfig(storageRoot);
  const store = await makeStore(config);
  const records = createRecords({ config, store });

  const raised = await records.raise(OP1, { title: 't', justification: 'j', workspace: '/w', vendor: 'claude' });
  assert.equal(raised.ok, true);
  if (!raised.ok) return;

  const [a, b] = await Promise.all([
    records.decide(raised.value.requisitionId, OP1, 'approve'),
    records.decide(raised.value.requisitionId, OP2, 'reject'),
  ]);
  const winners = [a, b].filter((r) => r.ok);
  const losers = [a, b].filter((r) => !r.ok);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  const loser = losers[0]!;
  if (!loser.ok) assert.equal(loser.error.code, 'already_decided');
});

test('S13.5 — self-approval succeeds and is recorded', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-rec-'));
  const config = baseConfig(storageRoot);
  const store = await makeStore(config);
  const records = createRecords({ config, store });

  const raised = await records.raise(OP1, { title: 't', justification: 'j', workspace: '/w', vendor: 'claude' });
  assert.equal(raised.ok, true);
  if (!raised.ok) return;

  const decided = await records.decide(raised.value.requisitionId, OP1, 'approve');
  assert.equal(decided.ok, true);
  if (decided.ok) {
    assert.equal(decided.value.decidedBy, OP1);
    assert.equal(decided.value.raisedBy, OP1);
  }
});

test('S13.7 — claim against open/rejected is requisition_not_approved; an unknown id is no_such_requisition', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-rec-'));
  const config = baseConfig(storageRoot);
  const store = await makeStore(config);
  const records = createRecords({ config, store });

  const openOne = await records.raise(OP1, { title: 't', justification: 'j', workspace: '/w', vendor: 'claude' });
  assert.equal(openOne.ok, true);
  if (!openOne.ok) return;
  const claimedOpen = records.claim(openOne.value.requisitionId);
  assert.equal(claimedOpen.ok, false);
  if (!claimedOpen.ok) assert.equal(claimedOpen.error.code, 'requisition_not_approved');

  const rejected = await records.raise(OP1, { title: 't2', justification: 'j', workspace: '/w', vendor: 'claude' });
  assert.equal(rejected.ok, true);
  if (!rejected.ok) return;
  await records.decide(rejected.value.requisitionId, OP2, 'reject');
  const claimedRejected = records.claim(rejected.value.requisitionId);
  assert.equal(claimedRejected.ok, false);
  if (!claimedRejected.ok) assert.equal(claimedRejected.error.code, 'requisition_not_approved');

  const unknown = records.claim('no-such-id' as never);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, 'no_such_requisition');
});

test('S13.6/I33/I5 — a second claim in the same tick is requisition_consumed, before either append has landed', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-rec-'));
  const config = baseConfig(storageRoot);
  const store = await makeStore(config);
  const records = createRecords({ config, store });

  const raised = await records.raise(OP1, { title: 't', justification: 'j', workspace: '/w', vendor: 'claude' });
  assert.equal(raised.ok, true);
  if (!raised.ok) return;
  await records.decide(raised.value.requisitionId, OP2, 'approve');

  const first = records.claim(raised.value.requisitionId);
  const second = records.claim(raised.value.requisitionId);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.error.code, 'requisition_consumed');
});

test('S13.9 — release returns a claimed requisition to spendable', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-rec-'));
  const config = baseConfig(storageRoot);
  const store = await makeStore(config);
  const records = createRecords({ config, store });

  const raised = await records.raise(OP1, { title: 't', justification: 'j', workspace: '/w', vendor: 'claude' });
  assert.equal(raised.ok, true);
  if (!raised.ok) return;
  await records.decide(raised.value.requisitionId, OP2, 'approve');

  const claimed = records.claim(raised.value.requisitionId);
  assert.equal(claimed.ok, true);
  records.release(raised.value.requisitionId);

  const reclaimed = records.claim(raised.value.requisitionId);
  assert.equal(reclaimed.ok, true);
});

test('S13.11 — an oversized title or justification is refused, and nothing is appended', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-rec-'));
  const config = baseConfig(storageRoot, 8);
  const store = await makeStore(config);
  const records = createRecords({ config, store });

  const badTitle = await records.raise(OP1, { title: 'way too long for eight bytes', justification: 'ok', workspace: '/w', vendor: 'claude' });
  assert.equal(badTitle.ok, false);
  if (!badTitle.ok) {
    assert.equal(badTitle.error.code, 'bad_request');
    if (badTitle.error.code === 'bad_request') assert.equal(badTitle.error.field, 'title');
  }

  const badJust = await records.raise(OP1, { title: 'ok', justification: 'way too long for eight bytes', workspace: '/w', vendor: 'claude' });
  assert.equal(badJust.ok, false);
  if (!badJust.ok) {
    assert.equal(badJust.error.code, 'bad_request');
    if (badJust.error.code === 'bad_request') assert.equal(badJust.error.field, 'justification');
  }

  assert.equal(records.listRequisitions().length, 0);
  let raw = '';
  try {
    raw = await readFile(path.join(storageRoot, 'requisitions.ndjson'), 'utf8');
  } catch {
    raw = '';
  }
  assert.equal(raw.trim(), '');
});

test('S13.12 — a failed append leaves the registry and the file agreeing', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-rec-'));
  const config = baseConfig(storageRoot);
  const store = await makeStore(config);

  const failingStore: Store = {
    ...store,
    async appendRequisition() {
      return { ok: false, error: { code: 'io', path: 'requisitions.ndjson', detail: 'disk full' } };
    },
  };
  const records = createRecords({ config, store: failingStore });

  const raised = await records.raise(OP1, { title: 't', justification: 'j', workspace: '/w', vendor: 'claude' });
  assert.equal(raised.ok, false);
  if (!raised.ok) assert.equal(raised.error.code, 'storage');
  assert.equal(records.listRequisitions().length, 0);
});

test('S13.12/D120 — a decision append that fails leaves the requisition at its prior state, decidable again', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-rec-'));
  const config = baseConfig(storageRoot);
  const store = await makeStore(config);
  const records = createRecords({ config, store });
  const raised = await records.raise(OP1, { title: 't', justification: 'j', workspace: '/w', vendor: 'claude' });
  assert.equal(raised.ok, true);
  if (!raised.ok) return;

  let fail = true;
  const flakyStore: Store = {
    ...store,
    async appendRequisition(record) {
      if (fail) return { ok: false, error: { code: 'io', path: 'requisitions.ndjson', detail: 'disk full' } };
      return store.appendRequisition(record);
    },
  };
  const flakyRecords = createRecords({ config, store: flakyStore });
  await flakyRecords.boot(); // reload the one requisition already on disk from `records` above
  const firstAttempt = await flakyRecords.decide(raised.value.requisitionId, OP2, 'approve');
  assert.equal(firstAttempt.ok, false);
  if (!firstAttempt.ok) assert.equal(firstAttempt.error.code, 'storage');
  const stillOpen = flakyRecords.getRequisition(raised.value.requisitionId);
  assert.equal(stillOpen.ok, true);
  if (stillOpen.ok) assert.equal(stillOpen.value.state, 'open');

  fail = false;
  const retried = await flakyRecords.decide(raised.value.requisitionId, OP2, 'approve');
  assert.equal(retried.ok, true);
  if (retried.ok) assert.equal(retried.value.state, 'approved');
});

test('S13.13 — boot loads requisitions.ndjson, latest line per id', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-rec-'));
  const config = baseConfig(storageRoot);
  const store = await makeStore(config);
  const records = createRecords({ config, store });

  const raised = await records.raise(OP1, { title: 't', justification: 'j', workspace: '/w', vendor: 'claude' });
  assert.equal(raised.ok, true);
  if (!raised.ok) return;
  await records.decide(raised.value.requisitionId, OP2, 'approve');

  const reopened = createRecords({ config, store });
  assert.equal(reopened.listRequisitions().length, 0); // nothing loaded until boot()
  await reopened.boot();
  const listed = reopened.listRequisitions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.state, 'approved');
});

test('S13.14 — a torn trailing line reverts to the previous line for that id, at boot', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-rec-'));
  const config = baseConfig(storageRoot);
  const store = await makeStore(config);
  const records = createRecords({ config, store });

  const raised = await records.raise(OP1, { title: 't', justification: 'j', workspace: '/w', vendor: 'claude' });
  assert.equal(raised.ok, true);
  if (!raised.ok) return;
  await records.decide(raised.value.requisitionId, OP2, 'approve');

  // A torn trailing line: what would have been the 'consumed' line, cut off mid-write —
  // no closing brace, no trailing newline — mirroring S3.6/store's own torn-tail handling.
  // The last *complete* line on disk is still the 'approved' decision.
  await appendFile(path.join(storageRoot, 'requisitions.ndjson'), '{"requisitionId":"' + raised.value.requisitionId.slice(0, 4));

  const reopened = createRecords({ config, store });
  await reopened.boot();
  const after = reopened.getRequisition(raised.value.requisitionId);
  assert.equal(after.ok, true);
  if (after.ok) {
    assert.equal(after.value.state, 'approved'); // reverted from 'consumed'
    // S13.14: accepted behaviour — spendable again.
    const spendableAgain = reopened.claim(raised.value.requisitionId);
    assert.equal(spendableAgain.ok, true);
  }
});

test('S13.16 — there is no revocation route and no expiry: only the four documented transitions exist', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-rec-'));
  const config = baseConfig(storageRoot);
  const store = await makeStore(config);
  const records = createRecords({ config, store });

  const raised = await records.raise(OP1, { title: 't', justification: 'j', workspace: '/w', vendor: 'claude' });
  assert.equal(raised.ok, true);
  if (!raised.ok) return;
  await records.decide(raised.value.requisitionId, OP2, 'approve');
  const claimed = records.claim(raised.value.requisitionId);
  assert.equal(claimed.ok, true);
  const attached = await records.attachSession(raised.value.requisitionId, 'sess-1' as never);
  assert.equal(attached.ok, true);

  // Nothing in the `Records` interface can move a `consumed` requisition anywhere else —
  // a second `decide` on it is `already_decided` (I32's only four transitions), and there
  // is no `revoke` method to call at all.
  const redecided = await records.decide(raised.value.requisitionId, OP1, 'reject');
  assert.equal(redecided.ok, false);
  if (!redecided.ok) assert.equal(redecided.error.code, 'already_decided');
  assert.equal('revoke' in records, false);
});
