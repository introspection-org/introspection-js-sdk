/**
 * Converter for Vercel AI SDK telemetry spans → Gen AI semantic conventions.
 *
 * The Vercel AI SDK emits spans with `ai.*` attributes when
 * `experimental_telemetry: { isEnabled: true }` is set on streamText/generateText.
 * This converter translates those to `gen_ai.*` so the Introspection frontend
 * can render them in the conversation view.
 */
import type { Attributes } from "@opentelemetry/api";
/** Check if a span is a Vercel AI SDK span worth converting.
 * Only converts child "do*" spans (doStream, doGenerate) which have
 * the actual prompt/response data with proper message windows.
 * Parent wrapper spans (ai.streamText, ai.generateText) are skipped
 * to avoid duplicate conversation steps without user messages. */
export declare function isVercelAISpan(attrs: Attributes): boolean;
/**
 * Convert Vercel AI SDK `ai.*` attributes to `gen_ai.*` semconv attributes.
 * Returns only the gen_ai attributes to merge — does NOT remove originals.
 */
export declare function convertVercelAIToGenAI(attrs: Attributes): Record<string, unknown>;
//# sourceMappingURL=vercel.d.ts.map