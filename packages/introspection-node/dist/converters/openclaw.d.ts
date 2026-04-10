import type { Attributes } from "@opentelemetry/api";
/**
 * Detect openclaw spans by the presence of openclaw.* attributes.
 * openclaw does not set a distinguishing instrumentation scope, so we
 * use attribute-key presence instead.
 */
export declare function isOpenClawSpan(attrs?: Attributes): boolean;
/**
 * Replace mapped openclaw.* attributes with gen_ai semantic conventions.
 * Unmapped openclaw.* attributes (e.g. openclaw.channel, openclaw.sessionId)
 * are preserved unchanged.
 */
export declare function replaceOpenClawWithGenAI(
  attrs?: Attributes,
): Attributes;
//# sourceMappingURL=openclaw.d.ts.map
