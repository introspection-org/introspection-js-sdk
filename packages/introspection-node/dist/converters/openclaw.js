/**
 * OpenClaw attribute keys that have gen_ai semantic convention equivalents.
 * Other openclaw.* attributes (channel, sessionId, lane, etc.) are preserved as-is.
 *
 * @see https://github.com/openclaw/openclaw/tree/main/extensions/diagnostics-otel
 */
const OC = {
  MODEL: "openclaw.model",
  PROVIDER: "openclaw.provider",
  TOKENS_INPUT: "openclaw.tokens.input",
  TOKENS_OUTPUT: "openclaw.tokens.output",
};
const MAPPED_KEYS = new Set(Object.values(OC));
/**
 * Detect openclaw spans by the presence of openclaw.* attributes.
 * openclaw does not set a distinguishing instrumentation scope, so we
 * use attribute-key presence instead.
 */
export function isOpenClawSpan(attrs) {
  if (!attrs) return false;
  return Object.keys(attrs).some((key) => key.startsWith("openclaw."));
}
/**
 * Replace mapped openclaw.* attributes with gen_ai semantic conventions.
 * Unmapped openclaw.* attributes (e.g. openclaw.channel, openclaw.sessionId)
 * are preserved unchanged.
 */
export function replaceOpenClawWithGenAI(attrs) {
  if (!attrs) return {};
  const result = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (!MAPPED_KEYS.has(key)) {
      result[key] = value;
    }
  }
  if (attrs[OC.MODEL] !== undefined) {
    result["gen_ai.request.model"] = attrs[OC.MODEL];
  }
  if (attrs[OC.PROVIDER] !== undefined) {
    result["gen_ai.system"] = attrs[OC.PROVIDER];
  }
  if (attrs[OC.TOKENS_INPUT] !== undefined) {
    result["gen_ai.usage.input_tokens"] = attrs[OC.TOKENS_INPUT];
  }
  if (attrs[OC.TOKENS_OUTPUT] !== undefined) {
    result["gen_ai.usage.output_tokens"] = attrs[OC.TOKENS_OUTPUT];
  }
  return result;
}
