import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRecords } from './index.js';
import { createStore } from '../store/index.js';
import type { Config, OperatorId, SessionId, SessionSnapshot, Store } from '../contract/index.js';

function baseConfig(storageRoot: string, requisitionTextBytes = 1024, reviewBodyBytes = 1024): Config {
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
      reviewBodyBytes,
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

function snapshot(sessionId: string, owner: OperatorId = OP1): SessionSnapshot {
  return {
    sessionId: sessionId as SessionId,
    owner,
    vendor: 'claude',
    cwd: 'C:\\workspace\\proj' as never,
    createdAt: '2026-08-13T00:00:00.000Z' as never,
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

// ---------------------------------------------------------------------------
// S15 — Reviews
// ---------------------------------------------------------------------------

test('S15.2 — createReview returns 201-shaped draft with the snapshot copied; a subject/snapshot mismatch is bad_request', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-rec-'));
  const config = baseConfig(storageRoot);
  const store = await makeStore(config);
  const records = createRecords({ config, store });

  const snap = snapshot('sess-1');
  const created = await records.createReview(OP1, snap, { subject: 'sess-1' as SessionId, rating: 'meets', pip: false, body: 'good work' });
  assert.equal(created.ok, true);
  if (created.ok) {
    assert.equal(created.value.state, 'draft');
    assert.deepEqual(created.value.snapshot, snap);
    assert.equal(created.value.author, OP1);
  }

  const mismatched = await records.createReview(OP1, snap, { subject: 'sess-2' as SessionId, rating: null, pip: false, body: 'x' });
  assert.equal(mismatched.ok, false);
  if (!mismatched.ok) {
    assert.equal(mismatched.error.code, 'bad_request');
    if (mismatched.error.code === 'bad_request') assert.equal(mismatched.error.field, 'subject');
  }
});

test('S15.3/I31 — a draft is readable and writable by its author alone; another operator gets no_such_review for both', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-rec-'));
  const config = baseConfig(storageRoot);
  const store = await makeStore(config);
  const records = createRecords({ config, store });

  const created = await records.createReview(OP1, snapshot('sess-1'), { subject: 'sess-1' as SessionId, rating: null, pip: false, body: 'draft' });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const reviewId = created.value.reviewId;

  const readByAuthor = records.getReview(reviewId, OP1);
  assert.equal(readByAuthor.ok, true);

  const readByOther = records.getReview(reviewId, OP2);
  assert.equal(readByOther.ok, false);
  if (!readByOther.ok) assert.equal(readByOther.error.code, 'no_such_review');

  const appendByOther = await records.appendReview(reviewId, OP2, { body: 'hijacked' });
  assert.equal(appendByOther.ok, false);
  if (!appendByOther.ok) assert.equal(appendByOther.error.code, 'no_such_review');
});

test('S15.4 — GET /api/reviews-shape (listReviews) returns finals only, for every caller including the draft author', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-rec-'));
  const config = baseConfig(storageRoot);
  const store = await makeStore(config);
  const records = createRecords({ config, store });

  const draft = await records.createReview(OP1, snapshot('sess-1'), { subject: 'sess-1' as SessionId, rating: null, pip: false, body: 'draft' });
  assert.equal(draft.ok, true);
  if (!draft.ok) return;

  assert.equal(records.listReviews('sess-1' as SessionId).length, 0);

  const finalised = await records.finaliseReview(draft.value.reviewId, OP1);
  assert.equal(finalised.ok, true);

  const listedByAuthor = records.listReviews('sess-1' as SessionId);
  const listedByOther = records.listReviews('sess-1' as SessionId);
  assert.equal(listedByAuthor.length, 1);
  assert.equal(listedByOther.length, 1);
  assert.equal(listedByAuthor[0]!.state, 'final');
});

test('S15.5/D65 — editing a draft appends a new line for the same reviewId; the latest line wins on read', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-rec-'));
  const config = baseConfig(storageRoot);
  const store = await makeStore(config);
  const records = createRecords({ config, store });

  const created = await records.createReview(OP1, snapshot('sess-1'), { subject: 'sess-1' as SessionId, rating: null, pip: false, body: 'v1' });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const edited = await records.appendReview(created.value.reviewId, OP1, { body: 'v2', rating: 'exceeds' });
  assert.equal(edited.ok, true);
  if (edited.ok) {
    assert.equal(edited.value.body, 'v2');
    assert.equal(edited.value.rating, 'exceeds');
  }

  const raw = await readFile(path.join(storageRoot, 'reviews.ndjson'), 'utf8');
  const lines = raw.trim().split('\n');
  assert.equal(lines.length, 2, 'each edit appends a new line; the earlier line stays on disk');

  const read = records.getReview(created.value.reviewId, OP1);
  assert.equal(read.ok, true);
  if (read.ok) assert.equal(read.value.body, 'v2');
});

test('S15.6/I29 — finalise moves draft to final once; a further append or a second finalise is 409 review_final', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-rec-'));
  const config = baseConfig(storageRoot);
  const store = await makeStore(config);
  const records = createRecords({ config, store });

  const created = await records.createReview(OP1, snapshot('sess-1'), { subject: 'sess-1' as SessionId, rating: null, pip: false, body: 'draft' });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const finalised = await records.finaliseReview(created.value.reviewId, OP1);
  assert.equal(finalised.ok, true);
  if (finalised.ok) assert.equal(finalised.value.state, 'final');

  const secondFinalise = await records.finaliseReview(created.value.reviewId, OP1);
  assert.equal(secondFinalise.ok, false);
  if (!secondFinalise.ok) assert.equal(secondFinalise.error.code, 'review_final');

  const furtherAppend = await records.appendReview(created.value.reviewId, OP1, { body: 'too late' });
  assert.equal(furtherAppend.ok, false);
  if (!furtherAppend.ok) assert.equal(furtherAppend.error.code, 'review_final');

  // Now readable by every authenticated operator, including a non-author.
  const readByOther = records.getReview(created.value.reviewId, OP2);
  assert.equal(readByOther.ok, true);
});

test('S15.8/D84 — an oversized body is refused 422 on create and on edit, and nothing is appended', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-rec-'));
  const config = baseConfig(storageRoot, 1024, 8);
  const store = await makeStore(config);
  const records = createRecords({ config, store });

  const created = await records.createReview(OP1, snapshot('sess-1'), {
    subject: 'sess-1' as SessionId,
    rating: null,
    pip: false,
    body: 'way too long for eight bytes',
  });
  assert.equal(created.ok, false);
  if (!created.ok) {
    assert.equal(created.error.code, 'bad_request');
    if (created.error.code === 'bad_request') assert.equal(created.error.field, 'body');
  }
  assert.equal(records.listReviews('sess-1' as SessionId).length, 0);
  let raw = '';
  try {
    raw = await readFile(path.join(storageRoot, 'reviews.ndjson'), 'utf8');
  } catch {
    raw = '';
  }
  assert.equal(raw.trim(), '');

  const fits = await records.createReview(OP1, snapshot('sess-1'), { subject: 'sess-1' as SessionId, rating: null, pip: false, body: 'ok' });
  assert.equal(fits.ok, true);
  if (!fits.ok) return;
  const oversizedEdit = await records.appendReview(fits.value.reviewId, OP1, { body: 'way too long for eight bytes' });
  assert.equal(oversizedEdit.ok, false);
  if (!oversizedEdit.ok) {
    assert.equal(oversizedEdit.error.code, 'bad_request');
    if (oversizedEdit.error.code === 'bad_request') assert.equal(oversizedEdit.error.field, 'body');
  }
  const unchanged = records.getReview(fits.value.reviewId, OP1);
  assert.equal(unchanged.ok, true);
  if (unchanged.ok) assert.equal(unchanged.value.body, 'ok');
});

test('S15.9/I35/D72 — PIP status is the pip of the final review with the greatest updatedAt; a draft changes nothing', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-rec-'));
  const config = baseConfig(storageRoot);
  const store = await makeStore(config);
  const records = createRecords({ config, store });

  const first = await records.createReview(OP1, snapshot('sess-1'), { subject: 'sess-1' as SessionId, rating: null, pip: true, body: 'first' });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  await records.finaliseReview(first.value.reviewId, OP1);
  assert.equal(records.isUnderPip('sess-1' as SessionId), true);

  // A draft with `pip: true` must change nothing — drafts are excluded entirely.
  const draft = await records.createReview(OP2, snapshot('sess-1', OP2), { subject: 'sess-1' as SessionId, rating: null, pip: true, body: 'draft' });
  assert.equal(draft.ok, true);
  assert.equal(records.isUnderPip('sess-1' as SessionId), true); // unchanged by the draft, still true from `first`

  // A later final with `pip: false` supersedes it.
  const second = await records.createReview(OP2, snapshot('sess-1', OP2), { subject: 'sess-1' as SessionId, rating: null, pip: false, body: 'second' });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  await records.finaliseReview(second.value.reviewId, OP2);
  assert.equal(records.isUnderPip('sess-1' as SessionId), false);
});

test('S15.9/D83 — a tie on updatedAt between two finals for the same subject is broken by the later line', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-rec-'));
  const config = baseConfig(storageRoot);
  const store = await makeStore(config);

  // Two finals for the same subject, hand-written with an identical `updatedAt` — the tie
  // this scenario cannot arise from live traffic within the same millisecond in a test, so
  // it is constructed directly the same way S13.14 constructs a torn tail.
  const tie = '2026-08-13T00:00:00.000Z';
  const earlier = {
    reviewId: 'rev-a', subject: 'sess-1', snapshot: snapshot('sess-1'), author: OP1, state: 'final',
    rating: null, pip: false, body: 'a', createdAt: tie, updatedAt: tie,
  };
  const later = {
    reviewId: 'rev-b', subject: 'sess-1', snapshot: snapshot('sess-1'), author: OP2, state: 'final',
    rating: null, pip: true, body: 'b', createdAt: tie, updatedAt: tie,
  };
  await writeFile(path.join(storageRoot, 'reviews.ndjson'), `${JSON.stringify(earlier)}\n${JSON.stringify(later)}\n`, 'utf8');

  const records = createRecords({ config, store });
  await records.boot();
  // `rev-b` is the later line, so its `pip: true` wins the tie.
  assert.equal(records.isUnderPip('sess-1' as SessionId), true);
});

test('S15.11/I37 — a failed review append leaves the registry and the file agreeing, with the operator\'s text unchanged', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-rec-'));
  const config = baseConfig(storageRoot);
  const store = await makeStore(config);

  const failingStore: Store = {
    ...store,
    async appendReview() {
      return { ok: false, error: { code: 'io', path: 'reviews.ndjson', detail: 'disk full' } };
    },
  };
  const records = createRecords({ config, store: failingStore });

  const created = await records.createReview(OP1, snapshot('sess-1'), { subject: 'sess-1' as SessionId, rating: null, pip: false, body: 'x' });
  assert.equal(created.ok, false);
  if (!created.ok) assert.equal(created.error.code, 'storage');
  assert.equal(records.listReviews('sess-1' as SessionId).length, 0);

  // Now with a review that exists (created against the real store), a failing edit must
  // leave both the registry and the file at the prior line.
  const workingRecords = createRecords({ config, store });
  const real = await workingRecords.createReview(OP1, snapshot('sess-1'), { subject: 'sess-1' as SessionId, rating: null, pip: false, body: 'original' });
  assert.equal(real.ok, true);
  if (!real.ok) return;

  let fail = true;
  const flakyStore: Store = {
    ...store,
    async appendReview(record) {
      if (fail) return { ok: false, error: { code: 'io', path: 'reviews.ndjson', detail: 'disk full' } };
      return store.appendReview(record);
    },
  };
  const flakyRecords = createRecords({ config, store: flakyStore });
  await flakyRecords.boot();
  const failedEdit = await flakyRecords.appendReview(real.value.reviewId, OP1, { body: 'retyped but not saved' });
  assert.equal(failedEdit.ok, false);
  if (!failedEdit.ok) assert.equal(failedEdit.error.code, 'storage');
  const stillOriginal = flakyRecords.getReview(real.value.reviewId, OP1);
  assert.equal(stillOriginal.ok, true);
  if (stillOriginal.ok) assert.equal(stillOriginal.value.body, 'original');

  fail = false;
  const retried = await flakyRecords.appendReview(real.value.reviewId, OP1, { body: 'retyped but not saved' });
  assert.equal(retried.ok, true);
  if (retried.ok) assert.equal(retried.value.body, 'retyped but not saved');
});

test('S15.12/I38 — boot loads reviews.ndjson, latest line per id; an unreadable file yields an empty registry', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-rec-'));
  const config = baseConfig(storageRoot);
  const store = await makeStore(config);
  const records = createRecords({ config, store });

  const created = await records.createReview(OP1, snapshot('sess-1'), { subject: 'sess-1' as SessionId, rating: null, pip: false, body: 'draft' });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  await records.finaliseReview(created.value.reviewId, OP1);

  const reopened = createRecords({ config, store });
  assert.equal(reopened.listReviews('sess-1' as SessionId).length, 0); // nothing loaded until boot()
  await reopened.boot();
  assert.equal(reopened.listReviews('sess-1' as SessionId).length, 1);

  // An unreadable log: never aborts boot, yields an empty registry (I38).
  const emptyRoot = await mkdtemp(path.join(tmpdir(), 'skynet-rec-'));
  const emptyConfig = baseConfig(emptyRoot);
  const emptyStore = await makeStore(emptyConfig);
  const freshRecords = createRecords({ config: emptyConfig, store: emptyStore });
  await freshRecords.boot();
  assert.equal(freshRecords.listReviews('sess-1' as SessionId).length, 0);
});

test('S15/I5 — two mutations dispatched in the same tick against one review yield exactly one success', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'skynet-rec-'));
  const config = baseConfig(storageRoot);
  const store = await makeStore(config);
  const records = createRecords({ config, store });

  const created = await records.createReview(OP1, snapshot('sess-1'), { subject: 'sess-1' as SessionId, rating: null, pip: false, body: 'v1' });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const [a, b] = await Promise.all([
    records.appendReview(created.value.reviewId, OP1, { body: 'race-a' }),
    records.finaliseReview(created.value.reviewId, OP1),
  ]);
  const winners = [a, b].filter((r) => r.ok);
  const losers = [a, b].filter((r) => !r.ok);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
});
