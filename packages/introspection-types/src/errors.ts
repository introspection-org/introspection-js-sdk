/**
 * Typed error hierarchy raised by the Introspection SDK.
 *
 * All HTTP errors extend `IntrospectionAPIError` and carry `status`,
 * `requestId`, `code`, and `body`. Specific subclasses are picked from the
 * combination of HTTP status + the `code` field on the JSON error body so
 * callers can `instanceof`-discriminate the common failure modes.
 *
 * Unknown 4xx/5xx codes fall through to the base `IntrospectionAPIError`.
 */
export class IntrospectionAPIError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly requestId: string | null;
  readonly body: unknown;

  constructor(opts: {
    message: string;
    status: number;
    code?: string | null;
    requestId?: string | null;
    body?: unknown;
  }) {
    super(opts.message);
    this.name = "IntrospectionAPIError";
    this.status = opts.status;
    this.code = opts.code ?? null;
    this.requestId = opts.requestId ?? null;
    this.body = opts.body;
  }
}

/** 401 — auth missing / invalid. */
export class AuthenticationError extends IntrospectionAPIError {
  constructor(opts: ConstructorParameters<typeof IntrospectionAPIError>[0]) {
    super(opts);
    this.name = "AuthenticationError";
  }
}

/** 403 with `code: "insufficient_scope"` — auth was valid but lacks a capability. */
export class InsufficientScopeError extends IntrospectionAPIError {
  readonly missingCapability: string | null;

  constructor(
    opts: ConstructorParameters<typeof IntrospectionAPIError>[0] & {
      missingCapability?: string | null;
    },
  ) {
    super(opts);
    this.name = "InsufficientScopeError";
    this.missingCapability = opts.missingCapability ?? null;
  }
}

/** 401 with `code: "runner_expired"` — the runner JWT is expired or revoked. */
export class RunnerExpiredError extends IntrospectionAPIError {
  constructor(opts: ConstructorParameters<typeof IntrospectionAPIError>[0]) {
    super(opts);
    this.name = "RunnerExpiredError";
  }
}

/** 404. */
export class NotFoundError extends IntrospectionAPIError {
  constructor(opts: ConstructorParameters<typeof IntrospectionAPIError>[0]) {
    super(opts);
    this.name = "NotFoundError";
  }
}

/** 409. */
export class ConflictError extends IntrospectionAPIError {
  constructor(opts: ConstructorParameters<typeof IntrospectionAPIError>[0]) {
    super(opts);
    this.name = "ConflictError";
  }
}

/** 400 / 422 — request shape was rejected by the server. */
export class ValidationError extends IntrospectionAPIError {
  constructor(opts: ConstructorParameters<typeof IntrospectionAPIError>[0]) {
    super(opts);
    this.name = "ValidationError";
  }
}

/** 429. Carries the `retryAfter` hint (seconds) from `Retry-After` if present. */
export class RateLimitError extends IntrospectionAPIError {
  readonly retryAfter: number | null;

  constructor(
    opts: ConstructorParameters<typeof IntrospectionAPIError>[0] & {
      retryAfter?: number | null;
    },
  ) {
    super(opts);
    this.name = "RateLimitError";
    this.retryAfter = opts.retryAfter ?? null;
  }
}

/** 503 / 504 — DP sandbox is unreachable / not warm. */
export class SandboxUnavailableError extends IntrospectionAPIError {
  constructor(opts: ConstructorParameters<typeof IntrospectionAPIError>[0]) {
    super(opts);
    this.name = "SandboxUnavailableError";
  }
}

/** SSE transport blew up mid-stream (after a 2xx open). */
export class StreamError extends IntrospectionAPIError {
  constructor(
    opts: Omit<
      ConstructorParameters<typeof IntrospectionAPIError>[0],
      "status"
    > & { status?: number },
  ) {
    super({ ...opts, status: opts.status ?? 0 });
    this.name = "StreamError";
  }
}

/** Transport failure before any HTTP response (DNS, TLS, abort, etc.). */
export class NetworkError extends IntrospectionAPIError {
  constructor(
    opts: Omit<
      ConstructorParameters<typeof IntrospectionAPIError>[0],
      "status"
    > & { status?: number },
  ) {
    super({ ...opts, status: opts.status ?? 0 });
    this.name = "NetworkError";
  }
}

interface ErrorMappingInput {
  status: number;
  message: string;
  code: string | null;
  requestId: string | null;
  body: unknown;
  retryAfter?: number | null;
}

/**
 * Construct the most specific `IntrospectionAPIError` subclass for the
 * given response. Used by the HTTP client to translate non-2xx responses
 * before throwing.
 */
export function apiErrorFromResponse(
  input: ErrorMappingInput,
): IntrospectionAPIError {
  const { status, code } = input;
  if (status === 401) {
    if (code === "runner_expired") return new RunnerExpiredError(input);
    return new AuthenticationError(input);
  }
  if (status === 403) {
    if (code === "insufficient_scope") {
      const missing = extractMissingCapability(input.body);
      return new InsufficientScopeError({
        ...input,
        missingCapability: missing,
      });
    }
    return new IntrospectionAPIError(input);
  }
  if (status === 404) return new NotFoundError(input);
  if (status === 409) return new ConflictError(input);
  if (status === 400 || status === 422) return new ValidationError(input);
  if (status === 429)
    return new RateLimitError({
      ...input,
      retryAfter: input.retryAfter ?? null,
    });
  if (status === 503 || status === 504)
    return new SandboxUnavailableError(input);
  return new IntrospectionAPIError(input);
}

function extractMissingCapability(body: unknown): string | null {
  if (body && typeof body === "object" && "missing_capability" in body) {
    const v = (body as { missing_capability: unknown }).missing_capability;
    if (typeof v === "string") return v;
  }
  return null;
}
