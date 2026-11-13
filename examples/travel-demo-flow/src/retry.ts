/** Statuses that mean the tunnel or the server failed, not that it answered. */
const TRANSIENT = new Set([429, 502, 503, 504, 530]);

/**
 * `fetch`, retried with capped exponential jitter while the answer is
 * transient. Acme's Person Server sits behind a Cloudflare tunnel, which
 * answers 530 for the few seconds a connection takes to re-register.
 */
export async function fetchRetrying(
  url: string,
  init: RequestInit,
  attempts = 5,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init).catch((err: unknown) => {
      if (attempt + 1 >= attempts) throw err;
      return null;
    });
    if (
      response &&
      (!TRANSIENT.has(response.status) || attempt + 1 >= attempts)
    )
      return response;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.random() * Math.min(500 * 2 ** attempt, 8000)),
    );
  }
}
