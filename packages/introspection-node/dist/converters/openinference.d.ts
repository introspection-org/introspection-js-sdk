import type { Attributes } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { GenAiAttributes } from "../types/genai.js";
/**
 * Check whether an OTel scope name belongs to an OpenInference instrumentor.
 *
 * @param scopeName - The `instrumentationScope.name` from a {@link ReadableSpan}.
 * @returns `true` when the scope starts with `"openinference"` or `"@arizeai/openinference"`.
 *
 * @example
 * ```ts
 * if (isOpenInferenceSpan(span.instrumentationScope.name)) {
 *   // convert attributes …
 * }
 * ```
 */
export declare function isOpenInferenceSpan(scopeName?: string): boolean;
/**
 * Convert OpenInference span attributes to camelCase {@link GenAiAttributes}.
 *
 * Extracts `llm.*`, `tool.*`, and `output.*` keys and maps them to the
 * corresponding Gen AI semantic convention fields.
 *
 * @param attrs - Raw OTel {@link Attributes} from an OpenInference span.
 * @returns A {@link GenAiAttributes} object with all recognised fields populated.
 *
 * @example
 * ```ts
 * const genAi = convertOpenInferenceToGenAI(span.attributes);
 * console.log(genAi.requestModel); // e.g. "gpt-4"
 * ```
 */
export declare function convertOpenInferenceToGenAI(attrs?: Attributes): GenAiAttributes;
/**
 * Replace all OpenInference `llm.*` / `tool.*` / `output.*` attributes with
 * their `gen_ai.*` equivalents, preserving every other attribute unchanged.
 *
 * @param attrs - Raw OTel {@link Attributes} that may contain OpenInference keys.
 * @returns A new {@link Attributes} dictionary with OpenInference keys replaced.
 *
 * @example
 * ```ts
 * const converted = replaceOpenInferenceWithGenAI(span.attributes);
 * // converted["gen_ai.request.model"] is set; "llm.model_name" is removed
 * ```
 */
export declare function replaceOpenInferenceWithGenAI(attrs?: Attributes): Attributes;
/**
 * Enrich a {@link ReadableSpan} with OpenInference attributes derived from its
 * `gen_ai.*` attributes.
 *
 * Use this when exporting Mastra traces to Arize / Phoenix, which expects
 * OpenInference conventions (`openinference.span.kind`, `llm.model_name`,
 * flattened `llm.input_messages.N.message.role`, token counts, etc.).
 *
 * @param span - The OTel {@link ReadableSpan} to enrich.
 * @returns A shallow copy of the span with additional OpenInference attributes.
 *
 * @example
 * ```ts
 * const enriched = addOpenInferenceAttributes(span);
 * exporter.export([enriched], cb);
 * ```
 */
export declare function addOpenInferenceAttributes(span: ReadableSpan): ReadableSpan;
/**
 * {@link SpanExporter} wrapper that enriches every span with OpenInference
 * attributes before forwarding it to the inner exporter.
 *
 * Use this when exporting Mastra / `gen_ai` traces to Arize or Phoenix.
 *
 * @example
 * ```ts
 * const otlp = new OTLPTraceExporter({ url: "https://otlp.arize.com/v1/traces" });
 * const exporter = new OpenInferenceSpanExporter(otlp);
 * provider.addSpanProcessor(new BatchSpanProcessor(exporter));
 * ```
 */
export declare class OpenInferenceSpanExporter implements SpanExporter {
    private inner;
    /**
     * @param inner - The downstream {@link SpanExporter} to forward enriched spans to.
     */
    constructor(inner: SpanExporter);
    /**
     * Enrich each span with OpenInference attributes, then forward the batch.
     *
     * @param spans - Completed spans to export.
     * @param resultCallback - Callback invoked with the export result code.
     */
    export(spans: ReadableSpan[], resultCallback: (result: {
        code: number;
    }) => void): void;
    /**
     * Shut down the inner exporter.
     *
     * @returns A promise that resolves when the inner exporter has shut down.
     */
    shutdown(): Promise<void>;
    /**
     * Flush any buffered spans in the inner exporter.
     *
     * @returns A promise that resolves when the flush completes.
     */
    forceFlush(): Promise<void>;
}
//# sourceMappingURL=openinference.d.ts.map