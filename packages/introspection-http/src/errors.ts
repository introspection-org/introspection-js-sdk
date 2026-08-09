import {
  IntrospectionAPIError,
  apiErrorFromResponse,
} from "@introspection-sdk/types";

/**
 * Render an error envelope's `detail` as a message.
 *
 * A validation failure comes back as a *list* of per-field objects
 * (`[{ loc: ["body", "name"], msg: "field required", type: "missing" }]`),
 * not a string. Only the string form was read, so the single most common
 * 4xx a caller hits surfaced as the bare text `HTTP 422` with every field
 * name and reason discarded.
 */
function renderDetail(detail: unknown): string | undefined {
  if (typeof detail === "string") return detail;
  if (!Array.isArray(detail) || detail.length === 0) return undefined;
  const parts = detail.map((entry) => {
    if (typeof entry === "string") return entry;
    if (!entry || typeof entry !== "object") return String(entry);
    const { loc, msg } = entry as { loc?: unknown; msg?: unknown };
    const where = Array.isArray(loc) ? loc.join(".") : undefined;
    const what = typeof msg === "string" ? msg : JSON.stringify(entry);
    return where ? `${where}: ${what}` : what;
  });
  return parts.join("; ");
}

/**
 * Map a non-ok `Response` to a typed {@link IntrospectionAPIError}.
 *
 * Reads the DP/CP error envelope (`detail` / `code` / `message`) when the
 * body is JSON, falls back to the raw text otherwise, and threads
 * `x-request-id` and `retry-after` through to the typed error. Shared by
 * the bearer-token (Node) and cookie (browser) transports — the error
 * shape is identical regardless of how the request was authenticated.
 */
/**
 * `Retry-After` in seconds, from either wire form.
 *
 * The header is defined as *either* a delta in seconds or an HTTP-date.
 * Reading only the numeric form turned every date-valued header into
 * `null`, which the retry path reads as "no floor supplied" and replaces
 * with its own much shorter backoff -- re-hitting a rate limiter that had
 * just told us exactly when to come back.
 */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds;
  const when = Date.parse(header);
  if (Number.isNaN(when)) return null;
  return Math.max(0, Math.ceil((when - Date.now()) / 1000));
}

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
      const detail = renderDetail(obj.detail);
      if (detail) message = detail;
      if (typeof obj.code === "string") code = obj.code;
      if (typeof obj.message === "string" && message === `HTTP ${res.status}`) {
        message = obj.message;
      }
    }
  } else {
    body = await res.text().catch(() => undefined);
  }
  const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
  return apiErrorFromResponse({
    status: res.status,
    message,
    code,
    requestId: res.headers.get("x-request-id"),
    body,
    retryAfter,
  });
}
