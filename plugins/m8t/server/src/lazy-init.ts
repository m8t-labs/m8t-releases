// One-shot lazy initialization with retry-on-failure.
//
// Caches a successful result forever; clears the cached promise on rejection
// so the next call re-runs `initFn` from scratch. This matters when the first
// failure is recoverable from the caller's side (e.g. ambiguous endpoint that
// the user resolves by writing a seed.yaml between calls).
export function createLazyInit<T>(initFn: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return () => {
    if (!promise) {
      const fresh = initFn();
      promise = fresh;
      // Side-chain a rejection handler that clears the cache so future calls
      // retry. The caller's await on `promise` (== `fresh`) still receives the
      // rejection through its own chain — this handler is a no-op-returning
      // bookkeeper.
      fresh.catch(() => {
        if (promise === fresh) promise = null;
      });
    }
    return promise;
  };
}
