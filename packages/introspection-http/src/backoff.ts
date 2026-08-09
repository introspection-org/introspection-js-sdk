/**
 * Shared retry/backoff primitives.
 *
 * Both the unary REST retry path ({@link BaseHttpClient.request}) and the
 * resumable run-stream ({@link streamResumable}) back off the same way — a
 * `Retry-After` floor plus capped exponential full jitter — and
 * both need an abort-aware sleep, so the math, the cap, and `sleep` live here
 * once rather than being copied into each. The *retry decision* (which
 * statuses, which methods, readiness vs severance) stays in each caller.
 */

/** Cap on the exponential/jitter component of a backoff step (ms). */
export const MAX_BACKOFF_MS = 10000;

/**
 * The server's `retryAfterMs` floor plus capped exponential full jitter.
 *
 * The floor is not capped. It used to be clamped to {@link MAX_BACKOFF_MS},
 * which meant a `429` answered with `Retry-After: 60` was retried after at
 * most 10s -- re-hitting the rate limiter 50s early, and contradicting every
 * place that calls this a floor. Only the jitter the SDK adds on top is
 * bounded; callers with a deadline clamp the total themselves.
 */
export function backoffMs(
  attempt: number,
  retryAfterMs: number | null,
  baseMs: number,
  random: () => number = Math.random,
): number {
  const floor = retryAfterMs ?? 0;
  const jitterRoom = Math.min(baseMs * 2 ** attempt, MAX_BACKOFF_MS);
  return floor + Math.floor(jitterRoom * random());
}

/** A `setTimeout` delay that rejects with the abort reason if `signal` fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
