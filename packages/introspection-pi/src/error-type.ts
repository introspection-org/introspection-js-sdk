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
export function classifyErrorType(
  message: string | undefined,
  fallback: string,
): string {
  if (message) {
    const status = /\b([45]\d{2})\b/.exec(message);
    if (status?.[1]) return status[1];
  }
  return fallback;
}

/** classifyErrorType for a thrown value: status code → class name → fallback. */
export function classifyThrownErrorType(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const status = /\b([45]\d{2})\b/.exec(message);
  if (status?.[1]) return status[1];
  if (error instanceof Error && error.name && error.name !== "Error") {
    return error.name;
  }
  return "exception";
}
