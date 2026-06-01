/**
 * Coverage for the typed error hierarchy + `apiErrorFromResponse` status→class
 * mapping. Pure constructors, no mocks.
 */
import { describe, expect, it } from "vitest";
import {
  apiErrorFromResponse,
  IntrospectionAPIError,
  AuthenticationError,
  RunnerExpiredError,
  InsufficientScopeError,
  NotFoundError,
  ConflictError,
  ValidationError,
  RateLimitError,
  SandboxUnavailableError,
  StreamError,
  NetworkError,
} from "@introspection-sdk/types";

function input(status: number, code: string | null = null, extra: object = {}) {
  return {
    status,
    message: `HTTP ${status}`,
    code,
    requestId: "req-1",
    body: {},
    ...extra,
  };
}

describe("apiErrorFromResponse", () => {
  it("401 → AuthenticationError, or RunnerExpiredError with code", () => {
    expect(apiErrorFromResponse(input(401))).toBeInstanceOf(
      AuthenticationError,
    );
    expect(apiErrorFromResponse(input(401, "runner_expired"))).toBeInstanceOf(
      RunnerExpiredError,
    );
  });

  it("403 → InsufficientScopeError (with capability) or base error", () => {
    const scoped = apiErrorFromResponse(
      input(403, "insufficient_scope", {
        body: { missing_capability: "runtimes:write" },
      }),
    );
    expect(scoped).toBeInstanceOf(InsufficientScopeError);
    expect((scoped as InsufficientScopeError).missingCapability).toBe(
      "runtimes:write",
    );

    const plain = apiErrorFromResponse(input(403));
    expect(plain).toBeInstanceOf(IntrospectionAPIError);
    expect(plain).not.toBeInstanceOf(InsufficientScopeError);

    // insufficient_scope without a usable body → null capability
    const noCap = apiErrorFromResponse(
      input(403, "insufficient_scope", { body: null }),
    );
    expect((noCap as InsufficientScopeError).missingCapability).toBeNull();
  });

  it("maps the remaining status codes to their subclasses", () => {
    expect(apiErrorFromResponse(input(404))).toBeInstanceOf(NotFoundError);
    expect(apiErrorFromResponse(input(409))).toBeInstanceOf(ConflictError);
    expect(apiErrorFromResponse(input(400))).toBeInstanceOf(ValidationError);
    expect(apiErrorFromResponse(input(422))).toBeInstanceOf(ValidationError);
    expect(apiErrorFromResponse(input(503))).toBeInstanceOf(
      SandboxUnavailableError,
    );
    expect(apiErrorFromResponse(input(504))).toBeInstanceOf(
      SandboxUnavailableError,
    );
  });

  it("429 → RateLimitError carrying retryAfter", () => {
    const withHint = apiErrorFromResponse(input(429, null, { retryAfter: 12 }));
    expect(withHint).toBeInstanceOf(RateLimitError);
    expect((withHint as RateLimitError).retryAfter).toBe(12);
    expect(
      (apiErrorFromResponse(input(429)) as RateLimitError).retryAfter,
    ).toBeNull();
  });

  it("unknown status falls through to the base error", () => {
    const err = apiErrorFromResponse(input(500));
    expect(err).toBeInstanceOf(IntrospectionAPIError);
    expect(err.constructor).toBe(IntrospectionAPIError);
    expect(err.status).toBe(500);
    expect(err.requestId).toBe("req-1");
  });
});

describe("transport errors default their status to 0", () => {
  it("StreamError and NetworkError", () => {
    const stream = new StreamError({
      message: "mid-stream",
      code: null,
      requestId: null,
    });
    expect(stream).toBeInstanceOf(IntrospectionAPIError);
    expect(stream.status).toBe(0);
    expect(stream.name).toBe("StreamError");

    const net = new NetworkError({
      message: "dns",
      code: null,
      requestId: null,
      body: undefined,
    });
    expect(net.status).toBe(0);
    expect(net.name).toBe("NetworkError");

    // explicit status override is honoured
    expect(
      new StreamError({
        message: "x",
        code: null,
        requestId: null,
        status: 499,
      }).status,
    ).toBe(499);
  });
});
