/**
 * Races a best-effort shutdown step against a bound (D222). Resolves `'settled'` when the step
 * finishes first and `'timeout'` when the bound does; a step that rejects before the bound
 * rejects here, so the caller's own catch logs it. A step that rejects *after* the bound has
 * fired is already abandoned and is dropped rather than left as an unhandled rejection — an
 * escape there would take the process down before the release step that follows. The timer is
 * deliberately not `unref`'d: it is cleared the moment the step settles and fires within the bound
 * otherwise, and an unref'd one would let the event loop drain — and the process exit — while a
 * stalled step is still pending, before the release step it exists to protect.
 */
export function boundStep(step: Promise<unknown>, boundMs: number): Promise<'settled' | 'timeout'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), boundMs);
    step.then(
      () => {
        clearTimeout(timer);
        resolve('settled');
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
