/**
 * Mastra-compatible Exporter for Introspection.
 *
 * Extends Mastra's BaseExporter to receive TracingEvents (Mastra's native
 * span format) and convert them to gen_ai.* OTel spans for the Introspection
 * backend.
 *
 * **Important:** This module requires `@mastra/observability` and `@mastra/core`
 * at runtime. Import via the subpath: `@introspection-sdk/introspection-node/mastra`
 *
 * @example
 * ```ts
 * import { Mastra } from "@mastra/core/mastra";
 * import { IntrospectionMastraExporter } from "@introspection-sdk/introspection-node/mastra";
 *
 * const mastra = new Mastra({
 *   agents: { myAgent },
 *   observability: {
 *     configs: {
 *       otel: {
 *         serviceName: "my-mastra-app",
 *         exporters: [new IntrospectionMastraExporter()],
 *       },
 *     },
 *   },
 * });
 * ```
 */

import { BaseExporter } from "@mastra/observability";
import type {
  TracingEvent,
  InitExporterOptions,
  AnyExportedSpan,
} from "@mastra/core/observability";

import {
  context as otelContext,
  trace as otelTrace,
  type Span as OtelSpan,
} from "@opentelemetry/api";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
  type IdGenerator,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { randomUUID } from "crypto";

import { logger } from "./utils.js";
import { VERSION } from "./version.js";
import type {
  InputMessage,
  OutputMessage,
  MessagePart,
} from "./types/genai.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Advanced options for testing and customization. */
export interface MastraExporterAdvancedOptions {
  /** Custom span exporter for testing. */
  spanExporter?: SpanExporter;
  /** Custom ID generator for testing. */
  idGenerator?: IdGenerator;
  /** Use SimpleSpanProcessor instead of BatchSpanProcessor. */
  useSimpleSpanProcessor?: boolean;
}

/** Configuration for {@link IntrospectionMastraExporter}. */
export interface IntrospectionMastraExporterOptions {
  /** Authentication token (env: INTROSPECTION_TOKEN). */
  token?: string;
  /** Base URL for the API (env: INTROSPECTION_BASE_URL). */
  baseUrl?: string;
  /** Additional headers to include in requests. */
  additionalHeaders?: Record<string, string>;
  /** Enable debug logging. */
  debug?: boolean;
  /** Advanced options for testing. */
  advanced?: MastraExporterAdvancedOptions;
}

// ---------------------------------------------------------------------------
// Exporter
// ---------------------------------------------------------------------------

export class IntrospectionMastraExporter extends BaseExporter {
  name = "introspection";

  private _options: IntrospectionMastraExporterOptions;
  private _tracerProvider?: BasicTracerProvider;
  private _tracer?: ReturnType<BasicTracerProvider["getTracer"]>;
  private _conversationIds: Map<string, string> = new Map();
  // Track root OTel spans per Mastra traceId so children share the same trace
  private _rootSpans: Map<string, OtelSpan> = new Map();

  constructor(options: IntrospectionMastraExporterOptions = {}) {
    super({ logLevel: options.debug ? "debug" : "info" });
    this._options = options;

    const token = options.token || process.env.INTROSPECTION_TOKEN;
    if (!token && !options.advanced?.spanExporter) {
      this.setDisabled("INTROSPECTION_TOKEN is required");
    }
  }

  /**
   * Called by Mastra after the instance is fully configured.
   * We defer TracerProvider creation to here so we can use the service name.
   */
  init(options: InitExporterOptions): void {
    if (this.isDisabled) return;

    const config = options.config as Record<string, unknown> | undefined;
    const serviceName = (config?.["serviceName"] as string) || "mastra-app";

    this._initProvider(serviceName);
  }

  private _initProvider(serviceName: string): void {
    if (this._tracerProvider) return; // Already initialized

    const opts = this._options;
    const advanced = opts.advanced;

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
    });

    if (advanced?.spanExporter) {
      const sp = advanced.useSimpleSpanProcessor
        ? new SimpleSpanProcessor(advanced.spanExporter)
        : new BatchSpanProcessor(advanced.spanExporter, {
            scheduledDelayMillis: 100,
          });
      this._tracerProvider = new BasicTracerProvider({
        resource,
        idGenerator: advanced.idGenerator,
        spanProcessors: [sp],
      });
      logger.info("IntrospectionMastraExporter initialized in test mode");
    } else {
      const token = opts.token || process.env.INTROSPECTION_TOKEN;
      if (!token) return;

      const baseUrl =
        opts.baseUrl ||
        process.env.INTROSPECTION_BASE_URL ||
        "https://otel.introspection.dev";
      const endpoint = baseUrl.endsWith("/v1/traces")
        ? baseUrl
        : `${baseUrl.replace(/\/$/, "")}/v1/traces`;

      const headers: Record<string, string> = {
        "User-Agent": `introspection-sdk/${VERSION}`,
        Authorization: `Bearer ${token}`,
        ...opts.additionalHeaders,
      };

      const spanExporter = new OTLPTraceExporter({ url: endpoint, headers });
      const effectiveBatchSize =
        token.startsWith("intro_dev") || token.startsWith("intro_staging")
          ? 1
          : undefined;
      const useSimple =
        advanced?.useSimpleSpanProcessor || effectiveBatchSize === 1;

      const sp = useSimple
        ? new SimpleSpanProcessor(spanExporter)
        : new BatchSpanProcessor(spanExporter, {
            scheduledDelayMillis: 1000,
            ...(effectiveBatchSize
              ? { maxExportBatchSize: effectiveBatchSize }
              : {}),
          });

      this._tracerProvider = new BasicTracerProvider({
        resource,
        idGenerator: advanced?.idGenerator,
        spanProcessors: [sp],
      });

      logger.info(
        `IntrospectionMastraExporter initialized: endpoint=${endpoint}, serviceName=${serviceName}`,
      );
    }

    this._tracer = this._tracerProvider.getTracer(
      "introspection-mastra",
      VERSION,
    );
  }

  protected async _exportTracingEvent(event: TracingEvent): Promise<void> {
    if (this.isDisabled) return;
    if (event.type !== "span_ended") return;

    // Lazy init if init() wasn't called
    if (!this._tracerProvider) {
      this._initProvider("mastra-app");
    }
    if (!this._tracer) return;

    this._exportSpan(event.exportedSpan);
  }

  async flush(): Promise<void> {
    await this._tracerProvider?.forceFlush();
  }

  async shutdown(): Promise<void> {
    // End any open root spans
    for (const span of this._rootSpans.values()) span.end();
    this._rootSpans.clear();
    await this._tracerProvider?.shutdown();
  }

  // -------------------------------------------------------------------------
  // Span routing
  // -------------------------------------------------------------------------

  private _exportSpan(span: AnyExportedSpan): void {
    switch (span.type as string) {
      case "agent_run":
        this._exportAgentRun(span);
        break;
      case "model_step":
        this._exportModelStep(span);
        break;
      case "tool_call":
      case "mcp_tool_call":
        this._exportToolCall(span);
        break;
      // model_generation — skipped; model_step has per-step tool calls
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Span creation with shared trace context
  // -------------------------------------------------------------------------

  /** Ensure a root OTel span exists for this Mastra trace.
   *  Events arrive in end-order (children first, agent_run last),
   *  so we create a synthetic root on first encounter. */
  private _ensureRoot(span: AnyExportedSpan): void {
    if (this._rootSpans.has(span.traceId)) return;
    const rootSpan = this._tracer!.startSpan("trace", {
      startTime: span.startTime,
    });
    this._rootSpans.set(span.traceId, rootSpan);
  }

  private _createSpan(span: AnyExportedSpan, name?: string): OtelSpan {
    this._ensureRoot(span);
    const parentCtx = otelTrace.setSpan(
      otelContext.active(),
      this._rootSpans.get(span.traceId)!,
    );
    return this._tracer!.startSpan(
      name || span.name,
      { startTime: span.startTime },
      parentCtx,
    );
  }

  // -------------------------------------------------------------------------
  // Span converters
  // -------------------------------------------------------------------------

  private _exportAgentRun(span: AnyExportedSpan): void {
    const attrs = span.attributes as Record<string, unknown> | undefined;
    const conversationId = this._getConversationId(span);

    // agent_run arrives last — set attrs on the synthetic root and end it
    this._ensureRoot(span);
    const rootSpan = this._rootSpans.get(span.traceId)!;
    rootSpan.setAttribute("gen_ai.conversation.id", conversationId);
    rootSpan.setAttribute(
      "gen_ai.agent.name",
      span.entityName || span.name || "agent",
    );

    if (attrs?.["instructions"] && typeof attrs["instructions"] === "string") {
      rootSpan.setAttribute(
        "gen_ai.system_instructions",
        JSON.stringify([{ type: "text", content: attrs["instructions"] }]),
      );
    }

    // Metadata passthrough
    if (span.metadata) {
      for (const [key, value] of Object.entries(span.metadata)) {
        if (value != null) {
          rootSpan.setAttribute(
            `ai.telemetry.metadata.${key}`,
            typeof value === "string" ? value : JSON.stringify(value),
          );
        }
      }
    }

    rootSpan.end(span.endTime || new Date());
    this._rootSpans.delete(span.traceId);
  }

  private _exportModelStep(span: AnyExportedSpan): void {
    const attrs = span.attributes as Record<string, unknown> | undefined;
    const conversationId = this._getConversationId(span);

    // Model info lives in metadata.modelMetadata (set by Mastra)
    const modelMeta = span.metadata?.["modelMetadata"] as
      | Record<string, unknown>
      | undefined;
    const model = (modelMeta?.["modelId"] as string) || "";
    const provider = (modelMeta?.["modelProvider"] as string) || "";

    // Response metadata from metadata.body (the API response)
    const respBody = span.metadata?.["body"] as
      | Record<string, unknown>
      | undefined;
    const responseModel = (respBody?.["model"] as string) || "";
    const responseId = (respBody?.["id"] as string) || "";

    const spanName = model ? `chat ${model}` : span.name;
    const otelSpan = this._createSpan(span, spanName);

    otelSpan.setAttribute("gen_ai.operation.name", "chat");
    otelSpan.setAttribute("gen_ai.conversation.id", conversationId);
    otelSpan.setAttribute("openinference.span.kind", "LLM");

    if (model) otelSpan.setAttribute("gen_ai.request.model", model);
    if (provider) otelSpan.setAttribute("gen_ai.system", provider);
    if (responseModel)
      otelSpan.setAttribute("gen_ai.response.model", responseModel);
    if (responseId) otelSpan.setAttribute("gen_ai.response.id", responseId);

    // Input messages — model_step has input.body.input (raw API messages)
    if (span.input != null) {
      const rawInput = span.input as Record<string, unknown>;
      const body = rawInput?.body as Record<string, unknown> | undefined;
      const apiMessages = body?.input ?? body?.messages;
      if (Array.isArray(apiMessages)) {
        const inputMessages = this._convertInput(apiMessages);
        if (inputMessages.length > 0) {
          otelSpan.setAttribute(
            "gen_ai.input.messages",
            JSON.stringify(inputMessages),
          );
        }

        // System instructions
        const systemMsgs = (apiMessages as Record<string, unknown>[]).filter(
          (m) => m.role === "system",
        );
        if (systemMsgs.length > 0) {
          otelSpan.setAttribute(
            "gen_ai.system_instructions",
            JSON.stringify(
              systemMsgs.map((m) => ({
                type: "text",
                content:
                  typeof m.content === "string"
                    ? m.content
                    : JSON.stringify(m.content),
              })),
            ),
          );
        }
      }

      // Tool definitions from input.body.tools
      const tools = body?.tools;
      if (Array.isArray(tools) && tools.length > 0) {
        otelSpan.setAttribute(
          "gen_ai.tool.definitions",
          JSON.stringify(
            (tools as Record<string, unknown>[]).map((t) => ({
              type: (t.type as string) || "function",
              name: (t.name as string) || "",
              description: (t.description as string) || "",
              parameters: t.parameters,
            })),
          ),
        );
      }
    }

    // Output messages — model_step output has {text, toolCalls} per step
    if (span.output != null) {
      const outputMessages = this._convertOutput(
        span.output,
        attrs?.["finishReason"] as string | undefined,
      );
      if (outputMessages.length > 0) {
        otelSpan.setAttribute(
          "gen_ai.output.messages",
          JSON.stringify(outputMessages),
        );
      }
    }

    // Token usage (per step)
    const usage = attrs?.["usage"] as Record<string, unknown> | undefined;
    if (usage) {
      if (typeof usage["inputTokens"] === "number")
        otelSpan.setAttribute(
          "gen_ai.usage.input_tokens",
          usage["inputTokens"],
        );
      if (typeof usage["outputTokens"] === "number")
        otelSpan.setAttribute(
          "gen_ai.usage.output_tokens",
          usage["outputTokens"],
        );
      const inputDetails = usage["inputDetails"] as
        | Record<string, unknown>
        | undefined;
      if (typeof inputDetails?.["cacheRead"] === "number")
        otelSpan.setAttribute(
          "gen_ai.usage.cache_read.input_tokens",
          inputDetails["cacheRead"],
        );
    }

    // Finish reason
    const finishReason = attrs?.["finishReason"] as string | undefined;
    if (finishReason)
      otelSpan.setAttribute("gen_ai.response.finish_reasons", [finishReason]);

    otelSpan.end(span.endTime || new Date());
  }

  private _exportToolCall(span: AnyExportedSpan): void {
    const conversationId = this._getConversationId(span);
    const toolName = span.entityName || span.name || "tool";

    const otelSpan = this._createSpan(span, toolName);
    otelSpan.setAttribute("gen_ai.tool.name", toolName);
    otelSpan.setAttribute("gen_ai.conversation.id", conversationId);
    otelSpan.setAttribute("openinference.span.kind", "TOOL");

    if (span.input != null) {
      otelSpan.setAttribute(
        "gen_ai.tool.input",
        typeof span.input === "string"
          ? span.input
          : JSON.stringify(span.input),
      );
    }
    if (span.output != null) {
      otelSpan.setAttribute(
        "gen_ai.tool.output",
        typeof span.output === "string"
          ? span.output
          : JSON.stringify(span.output),
      );
    }

    otelSpan.end(span.endTime || new Date());
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private _getConversationId(span: AnyExportedSpan): string {
    const metaConvId = span.metadata?.["gen_ai.conversation.id"] as
      | string
      | undefined;
    if (metaConvId) return metaConvId;

    const attrs = span.attributes as Record<string, unknown> | undefined;
    const attrConvId = attrs?.["conversationId"] as string | undefined;
    if (attrConvId) return attrConvId;

    const traceId = span.traceId;
    if (!this._conversationIds.has(traceId)) {
      this._conversationIds.set(
        traceId,
        `intro_conv_${randomUUID().replace(/-/g, "")}`,
      );
    }
    return this._conversationIds.get(traceId)!;
  }

  private _convertInput(input: unknown): InputMessage[] {
    if (!input) return [];
    if (Array.isArray(input)) {
      const result: InputMessage[] = [];
      for (const m of input) {
        const msg = m as Record<string, unknown>;
        if (!msg) continue;

        // Skip system messages (handled separately)
        if (msg.role === "system") continue;

        // Standard role-based messages
        if (msg.role) {
          result.push({
            role: msg.role as InputMessage["role"],
            parts: this._extractParts(msg.content),
          });
          continue;
        }

        // OpenAI Responses API: function_call_output (no role, has type)
        if (msg.type === "function_call_output") {
          result.push({
            role: "tool",
            parts: [
              {
                type: "tool_call_response",
                id: (msg.call_id || "") as string,
                response:
                  typeof msg.output === "string"
                    ? msg.output
                    : JSON.stringify(msg.output),
              },
            ],
          });
          continue;
        }

        // item_reference — skip (OpenAI internal reference)
        if (msg.type === "item_reference") continue;
      }
      return result;
    }
    if (typeof input === "string") {
      return [{ role: "user", parts: [{ type: "text", content: input }] }];
    }
    return [];
  }

  private _convertOutput(
    output: unknown,
    finishReason?: string,
  ): OutputMessage[] {
    if (!output) return [];
    const parts: MessagePart[] = [];

    if (typeof output === "string") {
      parts.push({ type: "text", content: output });
    } else if (typeof output === "object" && output !== null) {
      const out = output as Record<string, unknown>;

      // Reasoning
      if (Array.isArray(out.reasoning)) {
        for (const r of out.reasoning as Record<string, unknown>[]) {
          const text = (r.text || r.content || "") as string;
          if (text) parts.push({ type: "thinking", content: text });
        }
      }

      // Text
      if (typeof out.text === "string" && out.text) {
        parts.push({ type: "text", content: out.text });
      }

      // Tool calls
      if (Array.isArray(out.toolCalls)) {
        for (const tc of out.toolCalls as Record<string, unknown>[]) {
          parts.push({
            type: "tool_call",
            name: (tc.toolName || tc.name || "") as string,
            id: (tc.toolCallId || tc.id || "") as string,
            arguments:
              typeof tc.args === "string"
                ? tc.args
                : JSON.stringify(tc.args || tc.input),
          });
        }
      }
    }

    if (parts.length === 0) return [];
    return [{ role: "assistant", parts, finish_reason: finishReason }];
  }

  private _extractParts(content: unknown): MessagePart[] {
    if (typeof content === "string") {
      return [{ type: "text", content }];
    }
    if (Array.isArray(content)) {
      return content
        .map((part: unknown) => {
          const p = part as Record<string, unknown>;
          // Standard text
          if (p.type === "text")
            return {
              type: "text" as const,
              content: (p.text || p.content || "") as string,
            };
          // OpenAI Responses API input_text format
          if (p.type === "input_text")
            return {
              type: "text" as const,
              content: (p.text || "") as string,
            };
          // Tool call
          if (
            p.type === "tool-call" ||
            p.type === "tool_call" ||
            p.type === "function_call"
          )
            return {
              type: "tool_call" as const,
              name: (p.toolName || p.name || "") as string,
              id: (p.toolCallId || p.id || p.call_id || "") as string,
              arguments:
                typeof p.args === "string"
                  ? p.args
                  : typeof p.arguments === "string"
                    ? p.arguments
                    : JSON.stringify(p.args || p.arguments || p.input),
            };
          // Tool result
          if (
            p.type === "tool-result" ||
            p.type === "tool_call_response" ||
            p.type === "function_call_output"
          )
            return {
              type: "tool_call_response" as const,
              id: (p.toolCallId || p.id || p.call_id || "") as string,
              response:
                typeof p.result === "string"
                  ? p.result
                  : typeof p.output === "string"
                    ? p.output
                    : JSON.stringify(p.result || p.output),
            };
          // item_reference (OpenAI Responses API) — skip
          if (p.type === "item_reference") return null;
          return { type: "text" as const, content: JSON.stringify(p) };
        })
        .filter((p) => p !== null) as MessagePart[];
    }
    return [];
  }
}
