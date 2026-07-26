/**
 * Coalesces concurrent calls that map to the same key onto one in-flight promise: while a call is
 * still pending, every later call with an equal key gets the same promise back instead of invoking
 * `fn` again. The entry is dropped once it settles, so a subsequent call re-runs `fn`. Rejections
 * are shared too; deliberate: a coincident retry of a failing operation should see the same failure
 * rather than doubling the transport cost.
 */
export function singleFlight<A extends unknown[], R>(
  keyFn: (...args: A) => string,
  fn: (...args: A) => Promise<R>
): (...args: A) => Promise<R> {
  const inFlight = new Map<string, Promise<R>>();
  return (...args: A): Promise<R> => {
    const key = keyFn(...args);
    const existing = inFlight.get(key);
    if (existing) {
      return existing;
    }
    const promise = fn(...args).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  };
}
