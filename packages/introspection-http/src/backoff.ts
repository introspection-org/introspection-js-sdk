/**
 * Shared retry/backoff primitives.
 *
 * Both the unary REST retry path ({@link BaseHttpClient.request}) and the
 * resumable run-stream ({@link streamResumable}) back off the same way — a
 * capped-exponential delay with the server's `Retry-After` as a floor — and
 * both need an abort-aware sleep, so the math, the cap, and `sleep` live here
 * once rather than being copied into each. The *retry decision* (which
 * statuses, which methods, readiness vs severance) stays in each caller.
 */

/** Cap on any single backoff step (ms). */
export const MAX_BACKOFF_MS = 10000;

/**
 * Capped-exponential backoff: `baseMs * 2^attempt`, clamped to
 * {@link MAX_BACKOFF_MS}, with `retryAfterMs` used as the floor when present.
 */
export function backoffMs(
  attempt: number,
  retryAfterMs: number | null,
  baseMs: number,
): number {
  const exp = Math.min(baseMs * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.max(retryAfterMs ?? 0, exp);
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
