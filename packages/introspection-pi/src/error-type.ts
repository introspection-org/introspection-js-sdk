/**
 * Best-effort `error.type` classification per the semconv guidance: prefer
 * the provider's error code (HTTP status) or the canonical exception name,
 * falling back to a documented low-cardinality label.
 *
 * Values this instrumentation reports:
 * - a 4xx/5xx HTTP status extracted from the provider error message
 * - the thrown exception's class name (when it is a subclass of Error)
 * - `"model_error"` — the stream ended with a provider-reported error
 * - `"exception"` — the stream function itself threw
 * - `"tool_error"` — a tool execution returned an error result
 */
/**
 * A 4xx/5xx status in a provider error message.
 *
 * Deliberately narrow. A bare `/\b[45]\d{2}\b/` matched any three-digit
 * number in the message, so "context length 512 exceeded" and "returned 500
 * tokens" both reported themselves as HTTP statuses -- and `error.type` is a
 * low-cardinality metric dimension, where a wrong value is worse than the
 * honest fallback. The number now has to be introduced as a status, or lead
 * the message the way `429 Too Many Requests` does.
 */
const HTTP_STATUS_IN_MESSAGE =
  /(?:^|\b(?:status(?:\s*code)?|error\s*code|code|http)\b)\W{0,3}([45]\d{2})\b/i;

function statusFrom(message: string): string | undefined {
  return HTTP_STATUS_IN_MESSAGE.exec(message)?.[1];
}

export function classifyErrorType(
  message: string | undefined,
  fallback: string,
): string {
  if (message) {
    const status = statusFrom(message);
    if (status) return status;
  }
  return fallback;
}

/** classifyErrorType for a thrown value: status code → class name → fallback. */
export function classifyThrownErrorType(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const status = statusFrom(message);
  if (status) return status;
  if (error instanceof Error && error.name && error.name !== "Error") {
    return error.name;
  }
  return "exception";
}
