/**
 * AI SDK TelemetryIntegration for Introspection.
 *
 * Implements the Vercel AI SDK's TelemetryIntegration interface to capture
 * LLM interactions and export them as OpenTelemetry spans with gen_ai.*
 * semantic convention attributes to the Introspection backend.
 *
 * Similar to IntrospectionTracingProcessor for OpenAI Agents SDK and
 * IntrospectionClaudeHooks for Claude Agent SDK.
 *
 * @example
 * ```ts
 * import { IntrospectionAISDKIntegration } from "@introspection-sdk/introspection-node";
 * import { generateText } from "ai";
 * import { openai } from "@ai-sdk/openai";
 *
 * const introspection = new IntrospectionAISDKIntegration({
 *   token: "sk-intro-...",
 *   serviceName: "my-app",
 * });
 *
 * const { text } = await generateText({
 *   model: openai("gpt-4o"),
 *   prompt: "Hello!",
 *   experimental_telemetry: {
 *     isEnabled: true,
 *     integrations: [introspection],
 *   },
 * });
 *
 * await introspection.shutdown();
 * ```
 */

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

import {
  convertMessagesToInputMessages,
  extractSystemInstructions,
  buildOutputMessages,
  convertToolsToToolDefinitions,
} from "./converters/ai-sdk.js";
import type { InputMessage } from "./types/genai.js";
import { logger } from "./utils.js";
import { VERSION } from "./version.js";

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

/** Advanced options for testing and customization. */
export interface AISDKIntegrationAdvancedOptions {
  /** Custom span exporter (for testing — use InMemorySpanExporter). */
  spanExporter?: SpanExporter;
  /** Custom ID generator (for testing). */
  idGenerator?: IdGenerator;
  /** Use SimpleSpanProcessor instead of BatchSpanProcessor (for testing). */
  useSimpleSpanProcessor?: boolean;
  /** Maximum batch size for span export. */
  maxExportBatchSize?: number;
  /** Delay between batch exports in milliseconds. */
  scheduledDelayMillis?: number;
}

/** Configuration for {@link IntrospectionAISDKIntegration}. */
export interface IntrospectionAISDKIntegrationOptions {
  /** Authentication token (env: INTROSPECTION_TOKEN). */
  token?: string;
  /** Base URL for the API (env: INTROSPECTION_BASE_URL, default: "https://otel.introspection.dev"). */
  baseUrl?: string;
  /** Service name for telemetry (env: INTROSPECTION_SERVICE_NAME). */
  serviceName?: string;
  /** Additional headers to include in requests. */
  additionalHeaders?: Record<string, string>;
  /** Advanced options for testing and customization. */
  advanced?: AISDKIntegrationAdvancedOptions;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface GenerationState {
  rootSpan: OtelSpan;
  conversationId: string;
  system: unknown;
  metadata: Record<string, unknown> | undefined;
  stepSpans: Map<number, OtelSpan>;
  stepMessages: Map<number, InputMessage[]>;
  toolCallSpans: Map<string, OtelSpan>;
}

// ---------------------------------------------------------------------------
// Integration class
// ---------------------------------------------------------------------------

/**
 * AI SDK {@link TelemetryIntegration} that captures LLM interactions and
 * exports them as OpenTelemetry spans with `gen_ai.*` semantic convention
 * attributes to the Introspection backend.
 *
 * Creates its own {@link BasicTracerProvider} — no external OTel setup required.
 * Each generation (generateText/streamText call) produces:
 * - A root span grouping the entire operation
 * - Step spans (one per LLM call) with full gen_ai attributes
 * - Tool call spans nested under their parent step
 */
export class IntrospectionAISDKIntegration {
  private _tracerProvider: BasicTracerProvider;
  private _tracer: ReturnType<BasicTracerProvider["getTracer"]>;
  private _generation: GenerationState | null = null;

  constructor(options: IntrospectionAISDKIntegrationOptions = {}) {
    const advanced = options.advanced;
    const serviceName =
      options.serviceName || process.env.INTROSPECTION_SERVICE_NAME;
    const resource = serviceName
      ? resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName })
      : undefined;

    // Production mode — requires a token
    if (!advanced?.spanExporter) {
      const token = options.token || process.env.INTROSPECTION_TOKEN;
      if (!token) {
        throw new Error("INTROSPECTION_TOKEN is required");
      }

      const baseUrl =
        options.baseUrl ||
        process.env.INTROSPECTION_BASE_URL ||
        "https://otel.introspection.dev";

      const headers: Record<string, string> = {
        "User-Agent": `introspection-sdk/${VERSION}`,
        Authorization: `Bearer ${token}`,
        ...options.additionalHeaders,
      };

      const endpoint = baseUrl.endsWith("/v1/traces")
        ? baseUrl
        : `${baseUrl.replace(/\/$/, "")}/v1/traces`;

      logger.info(
        `IntrospectionAISDKIntegration initialized: endpoint=${endpoint}`,
      );

      const spanExporter = new OTLPTraceExporter({ url: endpoint, headers });

      // Use SimpleSpanProcessor for sequential export (dev/staging tokens)
      const effectiveBatchSize =
        advanced?.maxExportBatchSize ??
        (token.startsWith("intro_dev") || token.startsWith("intro_staging")
          ? 1
          : undefined);
      const useSimple =
        advanced?.useSimpleSpanProcessor || effectiveBatchSize === 1;
      const scheduledDelayMillis = advanced?.scheduledDelayMillis ?? 1000;

      const spanProcessor = useSimple
        ? new SimpleSpanProcessor(spanExporter)
        : new BatchSpanProcessor(spanExporter, {
            scheduledDelayMillis,
            ...(effectiveBatchSize
              ? { maxExportBatchSize: effectiveBatchSize }
              : {}),
          });

      this._tracerProvider = new BasicTracerProvider({
        resource,
        idGenerator: advanced?.idGenerator,
        spanProcessors: [spanProcessor],
      });
    } else {
      // Testing mode — use provided exporter
      logger.info(
        `IntrospectionAISDKIntegration initialized in test mode with custom exporter`,
      );

      const spanProcessor = advanced.useSimpleSpanProcessor
        ? new SimpleSpanProcessor(advanced.spanExporter)
        : new BatchSpanProcessor(advanced.spanExporter, {
            scheduledDelayMillis: 100,
          });

      this._tracerProvider = new BasicTracerProvider({
        resource,
        idGenerator: advanced.idGenerator,
        spanProcessors: [spanProcessor],
      });
    }

    this._tracer = this._tracerProvider.getTracer("ai-sdk", VERSION);
  }

  // -------------------------------------------------------------------------
  // TelemetryIntegration lifecycle methods
  //
  // Defined as arrow functions to preserve `this` binding when the AI SDK
  // calls them as plain function references.
  //
  // Event parameters use `unknown` for TypeScript compatibility with the
  // AI SDK's TelemetryIntegration interface (avoids index signature mismatch).
  // -------------------------------------------------------------------------

  /**
   * Called when a generation operation begins (before any LLM calls).
   * Creates a root span to group all steps in this generation.
   */
  onStart = (event: unknown): void => {
    try {
      const e = event as Record<string, unknown>;
      // End any lingering previous generation (safety net)
      if (this._generation) {
        this._endGeneration();
      }

      const model = e.model as
        | { provider?: string; modelId?: string }
        | undefined;
      const functionId = e.functionId as string | undefined;
      const metadata = e.metadata as Record<string, unknown> | undefined;
      const name = functionId || "ai-sdk-generation";

      // Conversation ID: metadata > auto-generate
      const metadataConvId = metadata?.["gen_ai.conversation.id"] as
        | string
        | undefined;
      const conversationId =
        metadataConvId || `intro_conv_${randomUUID().replace(/-/g, "")}`;

      const rootSpan = this._tracer.startSpan(name);
      rootSpan.setAttribute("gen_ai.conversation.id", conversationId);
      if (functionId) {
        rootSpan.setAttribute("gen_ai.agent.name", functionId);
      }
      if (model?.provider) {
        rootSpan.setAttribute("gen_ai.system", model.provider);
      }

      // Pass through all telemetry metadata as span attributes
      if (metadata) {
        for (const [key, value] of Object.entries(metadata)) {
          if (value !== undefined && value !== null) {
            rootSpan.setAttribute(
              `ai.telemetry.metadata.${key}`,
              typeof value === "string" ? value : JSON.stringify(value),
            );
          }
        }
      }

      this._generation = {
        rootSpan,
        conversationId,
        system: e.system,
        metadata,
        stepSpans: new Map(),
        stepMessages: new Map(),
        toolCallSpans: new Map(),
      };

      logger.debug(`Generation started: ${name} (${conversationId})`);
    } catch (error) {
      logger.error(
        `onStart error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  /**
   * Called when a step (individual LLM call) begins.
   * Creates a child span under the root span and captures input messages.
   */
  onStepStart = (event: unknown): void => {
    try {
      const e = event as Record<string, unknown>;
      const gen = this._generation;
      if (!gen) return;

      const stepNumber = (e.stepNumber as number) ?? 0;
      const model = e.model as
        | { provider?: string; modelId?: string }
        | undefined;
      const messages = (e.messages as readonly unknown[]) || [];
      const system = e.system ?? gen.system;
      const tools = e.tools;
      const functionId = e.functionId as string | undefined;

      // Create step span as child of root
      const parentCtx = otelTrace.setSpan(otelContext.active(), gen.rootSpan);
      const spanName = model?.modelId
        ? `chat ${model.modelId}`
        : `step-${stepNumber}`;
      const stepSpan = this._tracer.startSpan(spanName, {}, parentCtx);

      gen.stepSpans.set(stepNumber, stepSpan);

      // Capture input messages for use in onStepFinish
      const inputMessages = convertMessagesToInputMessages(messages);
      gen.stepMessages.set(stepNumber, inputMessages);

      // Set input-side attributes immediately
      stepSpan.setAttribute("gen_ai.operation.name", "chat");
      stepSpan.setAttribute("gen_ai.conversation.id", gen.conversationId);

      if (model?.provider) {
        stepSpan.setAttribute("gen_ai.system", model.provider);
      }
      if (model?.modelId) {
        stepSpan.setAttribute("gen_ai.request.model", model.modelId);
      }

      // System instructions
      const sysInstructions = extractSystemInstructions(system, messages);
      if (sysInstructions) {
        stepSpan.setAttribute(
          "gen_ai.system_instructions",
          JSON.stringify(sysInstructions),
        );
      }

      // Tool definitions
      const toolDefs = convertToolsToToolDefinitions(tools);
      if (toolDefs) {
        stepSpan.setAttribute(
          "gen_ai.tool.definitions",
          JSON.stringify(toolDefs),
        );
      }

      // Agent name from functionId
      if (functionId) {
        stepSpan.setAttribute("gen_ai.agent.name", functionId);
      }

      // Pass through telemetry metadata to step spans
      if (gen.metadata) {
        for (const [key, value] of Object.entries(gen.metadata)) {
          if (value !== undefined && value !== null) {
            stepSpan.setAttribute(
              `ai.telemetry.metadata.${key}`,
              typeof value === "string" ? value : JSON.stringify(value),
            );
          }
        }
      }

      logger.debug(`Step ${stepNumber} started: ${spanName}`);
    } catch (error) {
      logger.error(
        `onStepStart error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  /**
   * Called when a tool execution begins.
   * Creates a child span under the current step span.
   */
  onToolCallStart = (event: unknown): void => {
    try {
      const e = event as Record<string, unknown>;
      const gen = this._generation;
      if (!gen) return;

      const toolCall = e.toolCall as
        | { toolCallId?: string; toolName?: string; input?: unknown }
        | undefined;
      if (!toolCall) return;

      const stepNumber = (e.stepNumber as number) ?? 0;
      const parentSpan = gen.stepSpans.get(stepNumber) || gen.rootSpan;
      const parentCtx = otelTrace.setSpan(otelContext.active(), parentSpan);

      const toolName = toolCall.toolName || "unknown-tool";
      const toolSpan = this._tracer.startSpan(toolName, {}, parentCtx);
      toolSpan.setAttribute("gen_ai.tool.name", toolName);
      toolSpan.setAttribute("openinference.span.kind", "TOOL");

      if (toolCall.input !== undefined) {
        toolSpan.setAttribute(
          "gen_ai.tool.input",
          typeof toolCall.input === "string"
            ? toolCall.input
            : JSON.stringify(toolCall.input),
        );
      }

      // Propagate conversation ID
      toolSpan.setAttribute("gen_ai.conversation.id", gen.conversationId);

      const toolCallId =
        toolCall.toolCallId || `tool-${stepNumber}-${toolName}`;
      gen.toolCallSpans.set(toolCallId, toolSpan);

      logger.debug(`Tool call started: ${toolName} (${toolCallId})`);
    } catch (error) {
      logger.error(
        `onToolCallStart error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  /**
   * Called when a tool execution completes.
   * Sets output/error attributes and ends the tool span.
   */
  onToolCallFinish = (event: unknown): void => {
    try {
      const e = event as Record<string, unknown>;
      const gen = this._generation;
      if (!gen) return;

      const toolCall = e.toolCall as
        | { toolCallId?: string; toolName?: string }
        | undefined;
      if (!toolCall) return;

      const stepNumber = (e.stepNumber as number) ?? 0;
      const toolCallId =
        toolCall.toolCallId ||
        `tool-${stepNumber}-${toolCall.toolName || "unknown"}`;
      const toolSpan = gen.toolCallSpans.get(toolCallId);
      if (!toolSpan) return;

      gen.toolCallSpans.delete(toolCallId);

      const success = e.success as boolean;
      if (success && e.output !== undefined) {
        toolSpan.setAttribute(
          "gen_ai.tool.output",
          typeof e.output === "string" ? e.output : JSON.stringify(e.output),
        );
      } else if (!success && e.error !== undefined) {
        toolSpan.setAttribute(
          "gen_ai.tool.error",
          typeof e.error === "string"
            ? e.error
            : e.error instanceof Error
              ? e.error.message
              : JSON.stringify(e.error),
        );
      }

      if (typeof e.durationMs === "number") {
        toolSpan.setAttribute("gen_ai.tool.duration_ms", e.durationMs);
      }

      toolSpan.end();
      logger.debug(`Tool call finished: ${toolCall.toolName} (${toolCallId})`);
    } catch (error) {
      logger.error(
        `onToolCallFinish error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  /**
   * Called when a step (LLM call) completes.
   * Sets gen_ai attributes (input/output messages, usage, model) and ends
   * the step span.
   */
  onStepFinish = (event: unknown): void => {
    try {
      const e = event as Record<string, unknown>;
      const gen = this._generation;
      if (!gen) return;

      const stepNumber = (e.stepNumber as number) ?? 0;
      const stepSpan = gen.stepSpans.get(stepNumber);
      if (!stepSpan) {
        logger.debug(`No step span found for step ${stepNumber}`);
        return;
      }

      gen.stepSpans.delete(stepNumber);

      // Input messages (captured in onStepStart)
      const inputMessages = gen.stepMessages.get(stepNumber);
      gen.stepMessages.delete(stepNumber);

      if (inputMessages && inputMessages.length > 0) {
        stepSpan.setAttribute(
          "gen_ai.input.messages",
          JSON.stringify(inputMessages),
        );
      }

      // Output messages
      const outputMessages = buildOutputMessages({
        text: e.text as string | undefined,
        reasoningText: e.reasoningText as string | undefined,
        reasoning: e.reasoning as readonly { text?: string }[] | undefined,
        toolCalls: e.toolCalls as
          | readonly {
              toolCallId: string;
              toolName: string;
              input: unknown;
            }[]
          | undefined,
        finishReason: e.finishReason as string | undefined,
      });
      if (outputMessages.length > 0) {
        stepSpan.setAttribute(
          "gen_ai.output.messages",
          JSON.stringify(outputMessages),
        );
      }

      // Token usage
      const usage = e.usage as
        | {
            inputTokens?: number;
            outputTokens?: number;
            inputTokenDetails?: {
              cacheReadTokens?: number;
              cacheWriteTokens?: number;
            };
            outputTokenDetails?: { reasoningTokens?: number };
          }
        | undefined;
      if (usage) {
        if (usage.inputTokens !== undefined) {
          stepSpan.setAttribute("gen_ai.usage.input_tokens", usage.inputTokens);
        }
        if (usage.outputTokens !== undefined) {
          stepSpan.setAttribute(
            "gen_ai.usage.output_tokens",
            usage.outputTokens,
          );
        }
        if (usage.inputTokenDetails?.cacheReadTokens !== undefined) {
          stepSpan.setAttribute(
            "gen_ai.usage.cache_read.input_tokens",
            usage.inputTokenDetails.cacheReadTokens,
          );
        }
        if (usage.inputTokenDetails?.cacheWriteTokens !== undefined) {
          stepSpan.setAttribute(
            "gen_ai.usage.cache_creation.input_tokens",
            usage.inputTokenDetails.cacheWriteTokens,
          );
        }
      }

      // Response metadata
      const response = e.response as
        | { id?: string; modelId?: string }
        | undefined;
      if (response?.id) {
        stepSpan.setAttribute("gen_ai.response.id", response.id);
      }
      if (response?.modelId) {
        stepSpan.setAttribute("gen_ai.response.model", response.modelId);
      }

      // Finish reason
      const finishReason = e.finishReason as string | undefined;
      if (finishReason) {
        stepSpan.setAttribute("gen_ai.response.finish_reasons", [finishReason]);
      }

      // Model info (reinforces what was set in onStepStart)
      const model = e.model as
        | { provider?: string; modelId?: string }
        | undefined;
      if (model?.provider) {
        stepSpan.setAttribute("gen_ai.system", model.provider);
      }
      if (model?.modelId) {
        stepSpan.setAttribute("gen_ai.request.model", model.modelId);
      }

      stepSpan.setAttribute("openinference.span.kind", "LLM");
      stepSpan.end();
      logger.debug(`Step ${stepNumber} finished`);
    } catch (error) {
      logger.error(
        `onStepFinish error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  /**
   * Called when the entire generation completes (all steps finished).
   * Sets total usage on the root span and ends it.
   */
  onFinish = (event: unknown): void => {
    try {
      const e = event as Record<string, unknown>;
      const gen = this._generation;
      if (!gen) return;

      // End any orphaned tool call spans
      for (const [id, span] of gen.toolCallSpans) {
        span.end();
        logger.debug(`Ending orphaned tool call span: ${id}`);
      }
      gen.toolCallSpans.clear();

      // End any orphaned step spans
      for (const [stepNumber, span] of gen.stepSpans) {
        span.end();
        logger.debug(`Ending orphaned step span: ${stepNumber}`);
      }
      gen.stepSpans.clear();

      // Total usage on root span
      const totalUsage = e.totalUsage as
        | { inputTokens?: number; outputTokens?: number }
        | undefined;
      if (totalUsage) {
        if (totalUsage.inputTokens !== undefined) {
          gen.rootSpan.setAttribute(
            "gen_ai.usage.input_tokens",
            totalUsage.inputTokens,
          );
        }
        if (totalUsage.outputTokens !== undefined) {
          gen.rootSpan.setAttribute(
            "gen_ai.usage.output_tokens",
            totalUsage.outputTokens,
          );
        }
      }

      gen.rootSpan.end();
      this._generation = null;
      logger.debug("Generation finished");
    } catch (error) {
      logger.error(
        `onFinish error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  // -------------------------------------------------------------------------
  // Lifecycle methods
  // -------------------------------------------------------------------------

  /**
   * Shut down the tracer provider, flushing all pending spans.
   *
   * @returns A promise that resolves once shutdown is complete.
   */
  async shutdown(): Promise<void> {
    this._endGeneration();
    await this._tracerProvider.shutdown();
  }

  /**
   * Force-flush any buffered spans to the Introspection backend.
   *
   * @returns A promise that resolves once the flush completes.
   */
  async forceFlush(): Promise<void> {
    await this._tracerProvider.forceFlush();
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Cleanly end any active generation, closing all open spans. */
  private _endGeneration(): void {
    const gen = this._generation;
    if (!gen) return;

    for (const span of gen.toolCallSpans.values()) span.end();
    for (const span of gen.stepSpans.values()) span.end();
    gen.rootSpan.end();
    this._generation = null;
  }
}
