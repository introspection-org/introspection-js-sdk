/**
 * Header / body scrubbing for the recording proxy.
 *
 * Two-layer defense:
 *   - Block-list of known sensitive header names (case-insensitive).
 *   - Pattern check on remaining header values; refuses to persist if a
 *     recognizable secret slips through (fail-loud).
 *
 * Body scrubbing is conservative: replaces UUID-shaped values with a stable
 * placeholder so per-run randomness doesn't bust recording lookup, but
 * leaves the rest of the body intact.
 */

const SCRUB_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-claude-code-session-id",
  "x-claude-remote-session-id",
  "x-claude-remote-container-id",
  "cookie",
  "set-cookie",
  "openai-organization",
  "x-stainless-helper-method",
]);

// Patterns that, if seen in any header value after the block-list pass, mean
// our scrub list is incomplete and we should fail rather than persist.
const FAIL_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{10,}/,
  /\bsk-proj-[A-Za-z0-9_-]{10,}/,
  /\bBearer\s+sk-[A-Za-z0-9_-]{10,}/i,
  /\bgw-[A-Za-z0-9_-]{20,}/, // AnyLLM proxy gateway keys
];

export function scrubHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SCRUB_HEADERS.has(k.toLowerCase())) {
      result[k] = "[REDACTED]";
    } else {
      result[k] = v;
    }
  }
  for (const [k, v] of Object.entries(result)) {
    for (const pat of FAIL_PATTERNS) {
      if (pat.test(v)) {
        throw new Error(
          `[recording-proxy] header "${k}" contains a value matching ${pat} that the scrub list did not catch — refusing to persist. Update SCRUB_HEADERS in tests/recording-proxy/scrub.ts.`,
        );
      }
    }
  }
  return result;
}

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const UUID_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

// The Claude Agent SDK embeds a `cch=<hex>` nonce inside the
// `x-anthropic-billing-header` text on every outbound request. The value
// changes every call and would make hash lookups miss on replay. Scrub it
// before both hashing and persistence so recordings are reusable across runs.
const CCH_RE = /cch=[0-9a-f]+/gi;
const CCH_PLACEHOLDER = "cch=PLACEHOLDER";

// JSON fields whose values are SDK-injected defaults that drift between
// machines (different installed tools, default system prompts, SDK versions).
// They're irrelevant to the assertions the proxy tests make — those only
// care about identity attributes on resulting spans — so redacting them
// makes recordings portable across record / replay environments while still
// preserving the bits that distinguish one request from another (model,
// user messages, max_tokens, stream, metadata, tool_choice, etc.).
const NORMALIZED_BODY_FIELDS = ["system", "tools"] as const;
const BODY_FIELD_PLACEHOLDER = "[REDACTED-FOR-PORTABILITY]";

function normalizeAnthropicBody(body: string): string {
  if (!body) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return body;
  }
  const obj = parsed as Record<string, unknown>;
  let changed = false;
  for (const field of NORMALIZED_BODY_FIELDS) {
    if (field in obj) {
      obj[field] = BODY_FIELD_PLACEHOLDER;
      changed = true;
    }
  }
  return changed ? JSON.stringify(obj) : body;
}

export function scrubBody(body: string): string {
  if (!body) return body;
  return normalizeAnthropicBody(body)
    .replace(UUID_RE, UUID_PLACEHOLDER)
    .replace(CCH_RE, CCH_PLACEHOLDER);
}
