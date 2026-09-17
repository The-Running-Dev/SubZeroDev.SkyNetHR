// I27/A22: a lane is a synchronous transition boundary, never an asynchronous
// mutex. The event loop supplies exclusion; queued I/O is deliberately outside it.
export function createLane() {
  return {
    run<T>(transition: () => T): T {
      const result = transition();
      if (result !== null && typeof result === 'object' && 'then' in result) {
        throw new TypeError('A session transition must be synchronous');
      }
      return result as T;
    },
  };
}
