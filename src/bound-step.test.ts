import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundStep } from './bound-step.js';

// D222 (#342): `server.ts` awaits `manager.shutdown()` through this bound, so a stalled kill
// or tombstone append cannot hold release and exit. The subprocess tests in `server.test.ts`
// cannot make `manager.shutdown` never settle — the only route is a test seam, and § server
// bars a seam from changing what shutdown kills — so the bound is proved here, on the
// helper `server.ts` calls.

// `settled` is itself the proof that the bound was not waited out — had it fired first the outcome
// would be `timeout` — so no wall-clock check, which a loaded runner can trip (#382).
test('D222 — a step that settles inside the bound reports settled, and does not wait out the bound', async () => {
  const outcome = await boundStep(Promise.resolve('done'), 5000);
  assert.equal(outcome, 'settled', 'a settled step returns at once rather than at the bound');
});

test('D222 — a step that never settles is abandoned at the bound, so the next step is still reached', async () => {
  const never = new Promise<void>(() => undefined);
  let released = false;
  const outcome = await boundStep(never, 20);
  released = true; // stands in for step 4 (release): reachable only if the bound returned
  assert.equal(outcome, 'timeout');
  assert.equal(released, true);
});

test('D222 — a step that rejects inside the bound rejects the caller, so its own catch logs it', async () => {
  await assert.rejects(boundStep(Promise.reject(new Error('kill failed')), 5000), /kill failed/);
});

test('D222 — a step that rejects after the bound has fired is not an unhandled rejection', async () => {
  let rejectLate: (err: Error) => void = () => undefined;
  const late = new Promise<void>((_, reject) => {
    rejectLate = reject;
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    assert.equal(await boundStep(late, 20), 'timeout');
    rejectLate(new Error('too late'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});
