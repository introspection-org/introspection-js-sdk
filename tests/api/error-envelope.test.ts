/**
 * `toApiError` against the wire shapes the API actually returns.
 *
 * Both cases here were losing information silently: a validation failure
 * arrived as `HTTP 422` with the field names discarded, and a date-valued
 * `Retry-After` was read as no header at all.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { toApiError } from "@introspection-sdk/http";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("toApiError renders the error envelope's detail", () => {
  it("keeps reading the string form", async () => {
    const err = await toApiError(
      jsonResponse(404, { detail: "runtime not found" }),
    );
    expect(err.message).toBe("runtime not found");
  });

  it("renders a list-shaped validation detail instead of dropping it", async () => {
    // The single most common 4xx a caller hits. This used to surface as the
    // bare string "HTTP 422".
    const err = await toApiError(
      jsonResponse(422, {
        detail: [
          { loc: ["body", "name"], msg: "field required", type: "missing" },
          { loc: ["body", "ttl_seconds"], msg: "must be <= 86400" },
        ],
      }),
    );
    expect(err.status).toBe(422);
    expect(err.message).toContain("body.name: field required");
    expect(err.message).toContain("body.ttl_seconds: must be <= 86400");
    expect(err.message).not.toBe("HTTP 422");
  });

  it("falls back to the status line when detail carries nothing", async () => {
    const err = await toApiError(jsonResponse(500, { detail: [] }));
    expect(err.message).toBe("HTTP 500");
  });

  it("renders an entry with no loc using its message alone", async () => {
    const err = await toApiError(
      jsonResponse(422, { detail: [{ msg: "malformed body" }] }),
    );
    expect(err.message).toBe("malformed body");
  });
});

describe("toApiError parses both Retry-After forms", () => {
  it("reads the seconds form", async () => {
    const err = await toApiError(
      jsonResponse(429, { detail: "slow down" }, { "retry-after": "60" }),
    );
    expect(err.retryAfter).toBe(60);
  });

  it("reads the HTTP-date form as a delta in seconds", async () => {
    // Retry-After is defined as *either* a delta or a date. Reading only the
    // numeric form turned the date into `null`, which the retry path treats
    // as "no floor" -- so it backed off far less than the server asked for.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const err = await toApiError(
      jsonResponse(
        429,
        { detail: "slow down" },
        { "retry-after": "Thu, 01 Jan 2026 00:01:30 GMT" },
      ),
    );
    expect(err.retryAfter).toBe(90);
  });

  it("never reports a negative delta for a date already past", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:05:00Z"));
    const err = await toApiError(
      jsonResponse(
        429,
        { detail: "slow down" },
        { "retry-after": "Thu, 01 Jan 2026 00:01:30 GMT" },
      ),
    );
    expect(err.retryAfter).toBe(0);
  });

  it("reports no floor for an unparseable header", async () => {
    const err = await toApiError(
      jsonResponse(429, { detail: "slow down" }, { "retry-after": "soonish" }),
    );
    expect(err.retryAfter).toBeNull();
  });

  it("reads a negative delta as now, not as a negative delay", async () => {
    // Unclamped it became a negative floor in `backoffMs` and then a
    // negative `setTimeout`. All three SDKs clamp, the same way they all
    // clamp a date already in the past.
    const err = await toApiError(
      jsonResponse(429, { detail: "slow down" }, { "retry-after": "-5" }),
    );
    expect(err.retryAfter).toBe(0);
  });
});
