import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBudgetNotices, type BudgetNoticeDeps } from './budget.js';
import type { Envelope, EventPayloadMap, OperatorId, SessionId } from '../contract/index.js';

// An in-memory spill standing in for the session's durable event log. `append` lands a
// `session.notice` at the next `seq`, exactly as the host append path does; a restart is a
// fresh emitter over the same array, since the emitter holds nothing the spill does not.
const sessionId = 'session-1' as SessionId;
const owner = 'operator-1' as OperatorId;

function spill() {
  const events: Envelope[] = [];
  const push = (kind: Envelope['kind'], data: unknown): Envelope => {
    const envelope = { seq: events.length + 1, sessionId, ts: new Date().toISOString(), kind, data } as unknown as Envelope;
    events.push(envelope);
    return envelope;
  };
  let failAppends = 0;
  const deps: BudgetNoticeDeps = {
    async *readEvents() { for (const e of [...events]) yield { ok: true, value: e }; },
    async append(_id, _owner, data) {
      if (failAppends > 0) { failAppends--; return { ok: false, error: { code: 'storage' } }; }
      return { ok: true, value: push('session.notice', data) };
    },
    async flush() {},
  };
  return {
    events,
    deps,
    failNextAppends(n: number) { failAppends = n; },
    usage(inputTokens: number, outputTokens = 0, cacheRead = 0, cacheCreate = 0): Envelope {
      return push('usage', { turnId: 'turn-1', usage: { inputTokens, outputTokens, cacheRead, cacheCreate } });
    },
    notice(code: EventPayloadMap['session.notice']['code']): Envelope {
      return push('session.notice', { level: 'warn', code, text: code });
    },
  };
}

const notices = (events: Envelope[], code: string) =>
  events.filter(e => e.kind === 'session.notice' && (e.data as EventPayloadMap['session.notice']).code === code);

test('S39.2 — one budget_warning at level warn, after the envelope that crossed the 80% line, and none repeated', async () => {
  const s = spill();
  const budget = createBudgetNotices({ sessionTokenBudget: 1000, sessionTokenBudgetWarnFraction: 0.8 }, s.deps);
  s.usage(500); await budget.observe(sessionId, owner);
  assert.equal(notices(s.events, 'budget_warning').length, 0, 'nothing below the line');
  const crossing = s.usage(350); await budget.observe(sessionId, owner);
  s.usage(50); await budget.observe(sessionId, owner);
  const warnings = notices(s.events, 'budget_warning');
  assert.equal(warnings.length, 1);
  assert.equal((warnings[0]!.data as EventPayloadMap['session.notice']).level, 'warn');
  assert.ok((warnings[0]!.seq as number) > (crossing.seq as number), 'the notice follows the crossing envelope');
  assert.equal(notices(s.events, 'budget_exhausted').length, 0);
});

test('S39.2 — a crossing made only by cache-read and cache-creation tokens still fires the warning', async () => {
  const s = spill();
  const budget = createBudgetNotices({ sessionTokenBudget: 1000, sessionTokenBudgetWarnFraction: 0.8 }, s.deps);
  s.usage(100, 100); await budget.observe(sessionId, owner);
  s.usage(0, 0, 400, 250); await budget.observe(sessionId, owner);
  assert.equal(notices(s.events, 'budget_warning').length, 1, 'input + output + cacheRead + cacheCreate = 850');
});

test('S39.3 — one budget_exhausted at level warn, after the envelope that reached 1000, none at 1200', async () => {
  const s = spill();
  const budget = createBudgetNotices({ sessionTokenBudget: 1000, sessionTokenBudgetWarnFraction: 0.8 }, s.deps);
  for (const n of [500, 350, 50]) { s.usage(n); await budget.observe(sessionId, owner); }
  const reaching = s.usage(100); await budget.observe(sessionId, owner);
  s.usage(200); await budget.observe(sessionId, owner);
  const exhausted = notices(s.events, 'budget_exhausted');
  assert.equal(exhausted.length, 1);
  assert.equal((exhausted[0]!.data as EventPayloadMap['session.notice']).level, 'warn');
  assert.ok((exhausted[0]!.seq as number) > (reaching.seq as number));
  assert.equal(notices(s.events, 'budget_warning').length, 1);
});

test('S39.4 — one envelope from 0 to 1100 gives budget_warning, then budget_exhausted, in seq order', async () => {
  const s = spill();
  const budget = createBudgetNotices({ sessionTokenBudget: 1000, sessionTokenBudgetWarnFraction: 0.8 }, s.deps);
  const crossing = s.usage(1100); await budget.observe(sessionId, owner);
  const [warning] = notices(s.events, 'budget_warning');
  const [exhausted] = notices(s.events, 'budget_exhausted');
  assert.ok(warning && exhausted);
  assert.ok((crossing.seq as number) < (warning.seq as number));
  assert.ok((warning.seq as number) < (exhausted.seq as number));
});

test('S39.4 — concurrent observations of the same crossing still produce each notice once', async () => {
  const s = spill();
  const budget = createBudgetNotices({ sessionTokenBudget: 1000, sessionTokenBudgetWarnFraction: 0.8 }, s.deps);
  s.usage(1100);
  await Promise.all([budget.observe(sessionId, owner), budget.observe(sessionId, owner), budget.observe(sessionId, owner)]);
  assert.equal(notices(s.events, 'budget_warning').length, 1);
  assert.equal(notices(s.events, 'budget_exhausted').length, 1);
});

test('S39.5 — after a restart over the same spill, more usage adds no third notice, nor does raising the budget to 5000 and crossing the old line again', async () => {
  const s = spill();
  const before = createBudgetNotices({ sessionTokenBudget: 1000, sessionTokenBudgetWarnFraction: 0.8 }, s.deps);
  for (const n of [500, 350, 50, 100, 200]) { s.usage(n); await before.observe(sessionId, owner); }
  assert.equal(notices(s.events, 'budget_warning').length + notices(s.events, 'budget_exhausted').length, 2);

  const restarted = createBudgetNotices({ sessionTokenBudget: 1000, sessionTokenBudgetWarnFraction: 0.8 }, s.deps);
  s.usage(10); await restarted.observe(sessionId, owner);
  assert.equal(notices(s.events, 'budget_warning').length + notices(s.events, 'budget_exhausted').length, 2, 'no third notice after restart');

  const raised = createBudgetNotices({ sessionTokenBudget: 5000, sessionTokenBudgetWarnFraction: 0.8 }, s.deps);
  s.usage(3000); await raised.observe(sessionId, owner); // burn 4210, past 80% of 5000
  s.usage(1000); await raised.observe(sessionId, owner); // burn 5210, past 5000
  assert.equal(notices(s.events, 'budget_warning').length, 1, 'raising the budget does not re-arm the warning');
  assert.equal(notices(s.events, 'budget_exhausted').length, 1, 'raising the budget does not re-arm exhaustion');
});

test('S39.6 — a spill holding budget_exhausted and no budget_warning never gains a warning once a fraction is newly set', async () => {
  const s = spill();
  s.usage(1100);
  s.notice('budget_exhausted');
  const restarted = createBudgetNotices({ sessionTokenBudget: 1000, sessionTokenBudgetWarnFraction: 0.5 }, s.deps);
  for (const n of [10, 20, 30]) { s.usage(n); await restarted.observe(sessionId, owner); }
  assert.equal(notices(s.events, 'budget_warning').length, 0);
  assert.equal(notices(s.events, 'budget_exhausted').length, 1);
});

test('S39.7 — a crossing envelope with no notice (a crash between appends) gains the notice on the next usage envelope, and nothing without one', async () => {
  const s = spill();
  s.usage(900); // crossed 80% of 1000; the process died before the notice landed
  createBudgetNotices({ sessionTokenBudget: 1000, sessionTokenBudgetWarnFraction: 0.8 }, s.deps);
  assert.equal(notices(s.events, 'budget_warning').length, 0, 'nothing is emitted without a further usage envelope');

  const restarted = createBudgetNotices({ sessionTokenBudget: 1000, sessionTokenBudgetWarnFraction: 0.8 }, s.deps);
  const next = s.usage(10); await restarted.observe(sessionId, owner);
  const warnings = notices(s.events, 'budget_warning');
  assert.equal(warnings.length, 1);
  assert.ok((warnings[0]!.seq as number) > (next.seq as number));
});

test('S39.7 — a failed warning append defers both notices to the next usage envelope, warning first', async () => {
  const s = spill();
  const budget = createBudgetNotices({ sessionTokenBudget: 1000, sessionTokenBudgetWarnFraction: 0.8 }, s.deps);
  s.failNextAppends(1);
  s.usage(1100); await budget.observe(sessionId, owner);
  assert.equal(notices(s.events, 'budget_exhausted').length, 0, 'exhaustion never precedes its warning');
  s.usage(1); await budget.observe(sessionId, owner);
  const [warning] = notices(s.events, 'budget_warning');
  const [exhausted] = notices(s.events, 'budget_exhausted');
  assert.ok(warning && exhausted && (warning.seq as number) < (exhausted.seq as number));
});

test('S39.9 — with no budget nothing is ever emitted; with a budget and no fraction only budget_exhausted fires', async () => {
  const unbudgeted = spill();
  const off = createBudgetNotices({ sessionTokenBudget: null, sessionTokenBudgetWarnFraction: null }, unbudgeted.deps);
  for (const n of [1, 10_000, 1_000_000]) { unbudgeted.usage(n); await off.observe(sessionId, owner); }
  assert.equal(unbudgeted.events.filter(e => e.kind === 'session.notice').length, 0);

  const s = spill();
  const exhaustOnly = createBudgetNotices({ sessionTokenBudget: 1000, sessionTokenBudgetWarnFraction: null }, s.deps);
  for (const n of [900, 50, 100]) { s.usage(n); await exhaustOnly.observe(sessionId, owner); }
  assert.equal(notices(s.events, 'budget_warning').length, 0);
  assert.equal(notices(s.events, 'budget_exhausted').length, 1);
});

test('S39 — a session with no usage envelopes gains no notice, and an unreadable spill emits nothing', async () => {
  const s = spill();
  const budget = createBudgetNotices({ sessionTokenBudget: 1000, sessionTokenBudgetWarnFraction: 0.8 }, s.deps);
  await budget.observe(sessionId, owner);
  assert.equal(s.events.length, 0);

  const broken = createBudgetNotices({ sessionTokenBudget: 1000, sessionTokenBudgetWarnFraction: 0.8 }, {
    ...s.deps,
    async *readEvents() { yield { ok: true, value: s.usage(2000) }; yield { ok: false, error: { code: 'io', path: 'x', detail: 'unreadable' } }; },
  });
  await broken.observe(sessionId, owner);
  assert.equal(s.events.filter(e => e.kind === 'session.notice').length, 0);
});
