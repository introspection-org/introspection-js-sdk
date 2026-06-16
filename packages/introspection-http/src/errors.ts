import {
  IntrospectionAPIError,
  apiErrorFromResponse,
} from "@introspection-sdk/types";

/**
 * Map a non-ok `Response` to a typed {@link IntrospectionAPIError}.
 *
 * Reads the DP/CP error envelope (`detail` / `code` / `message`) when the
 * body is JSON, falls back to the raw text otherwise, and threads
 * `x-request-id` and `retry-after` through to the typed error. Shared by
 * the bearer-token (Node) and cookie (browser) transports — the error
 * shape is identical regardless of how the request was authenticated.
 */
export async function toApiError(
  res: Response,
): Promise<IntrospectionAPIError> {
  let body: unknown = undefined;
  let message = `HTTP ${res.status}`;
  let code: string | null = null;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("json")) {
    body = await res.json().catch(() => undefined);
    if (body && typeof body === "object") {
      const obj = body as Record<string, unknown>;
      if (typeof obj.detail === "string") message = obj.detail;
      if (typeof obj.code === "string") code = obj.code;
      if (typeof obj.message === "string" && message === `HTTP ${res.status}`) {
        message = obj.message;
      }
    }
  } else {
    body = await res.text().catch(() => undefined);
  }
  const retryAfterHeader = res.headers.get("retry-after");
  let retryAfter: number | null = null;
  if (retryAfterHeader) {
    const n = Number(retryAfterHeader);
    if (Number.isFinite(n)) retryAfter = n;
  }
  return apiErrorFromResponse({
    status: res.status,
    message,
    code,
    requestId: res.headers.get("x-request-id"),
    body,
    retryAfter,
  });
}
