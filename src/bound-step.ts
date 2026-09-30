/**
 * Races a best-effort shutdown step against a bound (D222). Resolves `'settled'` when the step
 * finishes first and `'timeout'` when the bound does; a step that rejects before the bound
 * rejects here, so the caller's own catch logs it. A step that rejects *after* the bound has
 * fired is already abandoned and is dropped rather than left as an unhandled rejection — an
 * escape there would take the process down before the release step that follows.
 */
export function boundStep(step: Promise<unknown>, boundMs: number): Promise<'settled' | 'timeout'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), boundMs);
    timer.unref();
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
