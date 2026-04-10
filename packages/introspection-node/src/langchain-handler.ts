/**
 * LangChain/LangGraph Callback Handler for Introspection.
 *
 * Hooks into LangChain's native callback system to capture LLM, tool, and
 * chain interactions as gen_ai.* OTel spans for the Introspection backend.
 *
 * Similar to IntrospectionTracingProcessor for OpenAI Agents SDK and
 * IntrospectionClaudeHooks for Claude Agent SDK.
 *
 * **Important:** This module requires `@langchain/core` at runtime.
 * Import via the subpath: `@introspection-sdk/introspection-node/langchain`
 *
 * @example
 * ```ts
 * import { IntrospectionCallbackHandler } from "@introspection-sdk/introspection-node/langchain";
 * import { ChatOpenAI } from "@langchain/openai";
 *
 * const handler = new IntrospectionCallbackHandler({
 *   serviceName: "my-langchain-app",
 * });
 *
 * const model = new ChatOpenAI({ modelName: "gpt-4o" });
 * const response = await model.invoke("Hello!", { callbacks: [handler] });
 *
 * await handler.shutdown();
 * ```
 */

import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult } from "@langchain/core/outputs";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChainValues } from "@langchain/core/utils/types";

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
export interface LangChainHandlerAdvancedOptions {
  /** Custom span exporter for testing. */
  spanExporter?: SpanExporter;
  /** Custom ID generator for testing. */
  idGenerator?: IdGenerator;
  /** Use SimpleSpanProcessor instead of BatchSpanProcessor. */
  useSimpleSpanProcessor?: boolean;
}

/** Configuration for {@link IntrospectionCallbackHandler}. */
export interface IntrospectionCallbackHandlerOptions {
  /** Authentication token (env: INTROSPECTION_TOKEN). */
  token?: string;
  /** Base URL for the API (env: INTROSPECTION_BASE_URL). */
  baseUrl?: string;
  /** Service name for telemetry (env: INTROSPECTION_SERVICE_NAME). */
  serviceName?: string;
  /** Additional headers to include in requests. */
  additionalHeaders?: Record<string, string>;
  /** Advanced options for testing. */
  advanced?: LangChainHandlerAdvancedOptions;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * LangChain callback handler that captures LLM, tool, and chain events
 * as gen_ai.* OTel spans and exports them to the Introspection backend.
 *
 * Pass as a callback to any LangChain invoke call, or set globally via
 * `setGlobalHandler()`.
 */
export class IntrospectionCallbackHandler extends BaseCallbackHandler {
  name = "IntrospectionCallbackHandler";

  private _tracerProvider: BasicTracerProvider;
  private _tracer: ReturnType<BasicTracerProvider["getTracer"]>;
  private _spans: Map<string, OtelSpan> = new Map();
  private _rootSpan: OtelSpan | null = null;
  private _conversationId: string;
  // Track span names and parents so children can resolve gen_ai.agent.name
  private _spanNames: Map<string, string> = new Map();
  private _spanParents: Map<string, string> = new Map();
  // LangChain wrapper names to skip when resolving agent names
  private static _wrapperNames = new Set([
    "RunnableSequence",
    "RunnableParallel",
    "RunnableMap",
    "RunnableLambda",
    "RunnableRetry",
    "_ConfigurableModel",
    "ChatOpenAI",
    "ChatAnthropic",
    "ChatGoogleGenerativeAI",
    "ChatGroq",
  ]);
  // Store LLM input messages per runId for use in handleLLMEnd
  private _llmInputs: Map<string, InputMessage[]> = new Map();

  constructor(options: IntrospectionCallbackHandlerOptions = {}) {
    super();

    const advanced = options.advanced;
    const serviceName =
      options.serviceName || process.env.INTROSPECTION_SERVICE_NAME;
    const resource = serviceName
      ? resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName })
      : undefined;

    if (!advanced?.spanExporter) {
      const token = options.token || process.env.INTROSPECTION_TOKEN;
      if (!token) {
        throw new Error("INTROSPECTION_TOKEN is required");
      }

      const baseUrl =
        options.baseUrl ||
        process.env.INTROSPECTION_BASE_URL ||
        "https://otel.introspection.dev";

      const endpoint = baseUrl.endsWith("/v1/traces")
        ? baseUrl
        : `${baseUrl.replace(/\/$/, "")}/v1/traces`;

      const headers: Record<string, string> = {
        "User-Agent": `introspection-sdk/${VERSION}`,
        Authorization: `Bearer ${token}`,
        ...options.additionalHeaders,
      };

      logger.info(
        `IntrospectionCallbackHandler initialized: endpoint=${endpoint}`,
      );

      const spanExporter = new OTLPTraceExporter({ url: endpoint, headers });

      const effectiveBatchSize =
        token.startsWith("intro_dev") || token.startsWith("intro_staging")
          ? 1
          : undefined;
      const useSimple =
        advanced?.useSimpleSpanProcessor || effectiveBatchSize === 1;

      const spanProcessor = useSimple
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
        spanProcessors: [spanProcessor],
      });
    } else {
      logger.info(
        "IntrospectionCallbackHandler initialized in test mode with custom exporter",
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

    this._tracer = this._tracerProvider.getTracer("langchain", VERSION);
    this._conversationId = `intro_conv_${randomUUID().replace(/-/g, "")}`;
  }

  /** Get or create a root span so all callbacks share the same traceId. */
  private _ensureRoot(): OtelSpan {
    if (!this._rootSpan) {
      this._rootSpan = this._tracer.startSpan("langchain-run");
      this._rootSpan.setAttribute(
        "gen_ai.conversation.id",
        this._conversationId,
      );
    }
    return this._rootSpan;
  }

  /** Create a child span under the root (or under a parent if provided).
   *  Sets gen_ai.agent.name to the parent span's name for hierarchy. */
  private _createChildSpan(
    name: string,
    runId: string,
    parentRunId?: string,
  ): OtelSpan {
    const parent =
      (parentRunId ? this._spans.get(parentRunId) : undefined) ||
      this._ensureRoot();
    const ctx = otelTrace.setSpan(otelContext.active(), parent);
    const span = this._tracer.startSpan(name, {}, ctx);
    this._spanNames.set(runId, name);
    if (parentRunId) {
      this._spanParents.set(runId, parentRunId);
    }

    // Walk up parents to find first non-wrapper name for gen_ai.agent.name
    const agentName = this._findAgentName(parentRunId);
    if (agentName) {
      span.setAttribute("gen_ai.agent.name", agentName);
    }

    return span;
  }

  // -------------------------------------------------------------------------
  // Chat model callbacks (preferred over LLM callbacks for chat models)
  // -------------------------------------------------------------------------

  handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): void {
    const modelName = this._extractModelName(llm, extraParams);
    const spanName = modelName ? `chat ${modelName}` : runName || "chat";

    const otelSpan = this._createChildSpan(spanName, runId, parentRunId);
    this._spans.set(runId, otelSpan);

    const conversationId = this._getConversationId(metadata);

    otelSpan.setAttribute("gen_ai.operation.name", "chat");
    otelSpan.setAttribute("gen_ai.conversation.id", conversationId);
    otelSpan.setAttribute("openinference.span.kind", "LLM");

    if (modelName) {
      otelSpan.setAttribute("gen_ai.request.model", modelName);
    }

    const flatMessages = messages[0] || [];
    const { inputMessages, systemInstructions } =
      this._convertMessages(flatMessages);

    if (inputMessages.length > 0) {
      otelSpan.setAttribute(
        "gen_ai.input.messages",
        JSON.stringify(inputMessages),
      );
      this._llmInputs.set(runId, inputMessages);
    }

    if (systemInstructions.length > 0) {
      otelSpan.setAttribute(
        "gen_ai.system_instructions",
        JSON.stringify(
          systemInstructions.map((s) => ({ type: "text", content: s })),
        ),
      );
    }

    const provider = this._extractProvider(llm);
    if (provider) {
      otelSpan.setAttribute("gen_ai.system", provider);
    }

    const invocationParams = extraParams?.["invocation_params"] as
      | Record<string, unknown>
      | undefined;

    const tools = invocationParams?.["tools"] as
      | Array<Record<string, unknown>>
      | undefined;
    if (tools && tools.length > 0) {
      otelSpan.setAttribute(
        "gen_ai.tool.definitions",
        JSON.stringify(
          tools.map((t) => {
            const fn = (t.function || t) as Record<string, unknown>;
            return {
              type: (t.type as string) || "function",
              name: (fn.name || "") as string,
              description: (fn.description || "") as string,
              parameters: fn.parameters,
            };
          }),
        ),
      );
    }

    if (invocationParams?.["temperature"] != null) {
      otelSpan.setAttribute(
        "gen_ai.request.temperature",
        invocationParams["temperature"] as number,
      );
    }
  }

  handleLLMStart(
    llm: Serialized,
    prompts: string[],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): void {
    const modelName = this._extractModelName(llm, extraParams);
    const spanName = modelName ? `chat ${modelName}` : runName || "llm";

    const otelSpan = this._createChildSpan(spanName, runId, parentRunId);
    this._spans.set(runId, otelSpan);

    const conversationId = this._getConversationId(metadata);

    otelSpan.setAttribute("gen_ai.operation.name", "chat");
    otelSpan.setAttribute("gen_ai.conversation.id", conversationId);
    otelSpan.setAttribute("openinference.span.kind", "LLM");

    if (modelName) {
      otelSpan.setAttribute("gen_ai.request.model", modelName);
    }

    if (prompts.length > 0) {
      const inputMessages: InputMessage[] = prompts.map((p) => ({
        role: "user" as const,
        parts: [{ type: "text" as const, content: p }],
      }));
      otelSpan.setAttribute(
        "gen_ai.input.messages",
        JSON.stringify(inputMessages),
      );
      this._llmInputs.set(runId, inputMessages);
    }
  }

  handleLLMEnd(output: LLMResult, runId: string): void {
    const otelSpan = this._spans.get(runId);
    if (!otelSpan) return;

    this._spans.delete(runId);
    this._spanNames.delete(runId);
    this._llmInputs.delete(runId);

    const generations = output.generations?.[0];
    if (generations && generations.length > 0) {
      const parts: MessagePart[] = [];
      for (const gen of generations) {
        if (gen.text) {
          parts.push({ type: "text", content: gen.text });
        }
        const msg = (gen as unknown as Record<string, unknown>).message as
          | Record<string, unknown>
          | undefined;
        const kwargs = (msg?.["kwargs"] || msg) as
          | Record<string, unknown>
          | undefined;
        const additionalKwargs = kwargs?.["additional_kwargs"] as
          | Record<string, unknown>
          | undefined;
        const toolCalls = (additionalKwargs?.["tool_calls"] ||
          kwargs?.["tool_calls"]) as Array<Record<string, unknown>> | undefined;
        if (toolCalls) {
          for (const tc of toolCalls) {
            const fn = (tc.function || tc) as Record<string, unknown>;
            parts.push({
              type: "tool_call",
              name: (fn.name || tc.name || "") as string,
              id: (tc.id || "") as string,
              arguments: (fn.arguments || tc.args || "") as string,
            });
          }
        }
      }

      if (parts.length > 0) {
        const outputMessages: OutputMessage[] = [{ role: "assistant", parts }];
        otelSpan.setAttribute(
          "gen_ai.output.messages",
          JSON.stringify(outputMessages),
        );
      }
    }

    const usage = output.llmOutput as Record<string, unknown> | undefined;
    const tokenUsage = (usage?.["tokenUsage"] ||
      usage?.["token_usage"] ||
      usage?.["usage"]) as Record<string, unknown> | undefined;
    if (tokenUsage) {
      const inputTokens =
        tokenUsage["promptTokens"] ||
        tokenUsage["prompt_tokens"] ||
        tokenUsage["input_tokens"];
      const outputTokens =
        tokenUsage["completionTokens"] ||
        tokenUsage["completion_tokens"] ||
        tokenUsage["output_tokens"];
      if (typeof inputTokens === "number") {
        otelSpan.setAttribute("gen_ai.usage.input_tokens", inputTokens);
      }
      if (typeof outputTokens === "number") {
        otelSpan.setAttribute("gen_ai.usage.output_tokens", outputTokens);
      }
    }

    const model = usage?.["model"] || usage?.["model_name"];
    if (typeof model === "string") {
      otelSpan.setAttribute("gen_ai.response.model", model);
    }

    // gen_ai.response.id — required by the server for conversation tracking.
    const responseId = usage?.["id"] || usage?.["system_fingerprint"];
    otelSpan.setAttribute(
      "gen_ai.response.id",
      typeof responseId === "string" ? responseId : `langchain-${runId}`,
    );

    otelSpan.end();
  }

  handleLLMError(err: Error, runId: string): void {
    const otelSpan = this._spans.get(runId);
    if (!otelSpan) return;
    this._spans.delete(runId);
    this._spanNames.delete(runId);
    this._llmInputs.delete(runId);
    otelSpan.setAttribute("error", true);
    otelSpan.setAttribute("error.message", err.message);
    otelSpan.end();
  }

  // -------------------------------------------------------------------------
  // Chain callbacks
  // -------------------------------------------------------------------------

  handleChainStart(
    chain: Serialized,
    _inputs: ChainValues,
    runId: string,
    _runType?: string,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
    parentRunId?: string,
  ): void {
    const name =
      runName || chain?.name || chain?.id?.[chain.id.length - 1] || "chain";

    const otelSpan = this._createChildSpan(name, runId, parentRunId);
    this._spans.set(runId, otelSpan);

    const conversationId = this._getConversationId(metadata);
    otelSpan.setAttribute("gen_ai.conversation.id", conversationId);
  }

  handleChainEnd(_outputs: ChainValues, runId: string): void {
    const otelSpan = this._spans.get(runId);
    if (!otelSpan) return;
    this._spans.delete(runId);
    otelSpan.end();
  }

  handleChainError(err: Error, runId: string): void {
    const otelSpan = this._spans.get(runId);
    if (!otelSpan) return;
    this._spans.delete(runId);
    otelSpan.setAttribute("error", true);
    otelSpan.setAttribute("error.message", err.message);
    otelSpan.end();
  }

  // -------------------------------------------------------------------------
  // Tool callbacks
  // -------------------------------------------------------------------------

  handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): void {
    const toolName =
      runName || tool?.name || tool?.id?.[tool.id.length - 1] || "tool";

    const otelSpan = this._createChildSpan(toolName, runId, parentRunId);
    this._spans.set(runId, otelSpan);

    otelSpan.setAttribute("gen_ai.tool.name", toolName);
    otelSpan.setAttribute("openinference.span.kind", "TOOL");
    otelSpan.setAttribute("gen_ai.tool.input", input);
    otelSpan.setAttribute("gen_ai.conversation.id", this._conversationId);
  }

  handleToolEnd(output: unknown, runId: string): void {
    const otelSpan = this._spans.get(runId);
    if (!otelSpan) return;
    this._spans.delete(runId);

    if (output != null) {
      otelSpan.setAttribute(
        "gen_ai.tool.output",
        typeof output === "string" ? output : JSON.stringify(output),
      );
    }

    otelSpan.end();
  }

  handleToolError(err: Error, runId: string): void {
    const otelSpan = this._spans.get(runId);
    if (!otelSpan) return;
    this._spans.delete(runId);
    otelSpan.setAttribute("error", true);
    otelSpan.setAttribute("error.message", err.message);
    otelSpan.end();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    for (const span of this._spans.values()) span.end();
    this._spans.clear();
    if (this._rootSpan) {
      this._rootSpan.end();
      this._rootSpan = null;
    }
    await this._tracerProvider.shutdown();
  }

  async forceFlush(): Promise<void> {
    await this._tracerProvider.forceFlush();
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private _extractModelName(
    llm: Serialized,
    extraParams?: Record<string, unknown>,
  ): string | undefined {
    const invocationParams = extraParams?.["invocation_params"] as
      | Record<string, unknown>
      | undefined;
    if (invocationParams) {
      const model =
        invocationParams["model"] ||
        invocationParams["model_name"] ||
        invocationParams["modelName"];
      if (typeof model === "string") return model;
    }

    const kwargs = (llm as unknown as Record<string, unknown>)?.kwargs as
      | Record<string, unknown>
      | undefined;
    if (kwargs) {
      const model =
        kwargs["model"] || kwargs["model_name"] || kwargs["modelName"];
      if (typeof model === "string") return model;
    }

    return undefined;
  }

  private _extractProvider(llm: Serialized): string | undefined {
    const id = llm?.id;
    if (Array.isArray(id) && id.length > 0) {
      return id[id.length - 1] as string;
    }
    return undefined;
  }

  /** Walk up the span tree to find the first non-wrapper span name. */
  private _findAgentName(runId?: string): string | undefined {
    let current = runId;
    for (let i = 0; i < 20 && current; i++) {
      const name = this._spanNames.get(current);
      if (name && !IntrospectionCallbackHandler._wrapperNames.has(name)) {
        return name;
      }
      current = this._spanParents.get(current);
    }
    return undefined;
  }

  private _getConversationId(metadata?: Record<string, unknown>): string {
    const metaConvId = metadata?.["gen_ai.conversation.id"] as
      | string
      | undefined;
    return metaConvId || this._conversationId;
  }

  private _convertMessages(messages: BaseMessage[]): {
    inputMessages: InputMessage[];
    systemInstructions: string[];
  } {
    const inputMessages: InputMessage[] = [];
    const systemInstructions: string[] = [];

    for (const msg of messages) {
      const msgType =
        (msg as unknown as { _getType?: () => string })._getType?.() ||
        (msg as unknown as Record<string, unknown>).type ||
        "unknown";
      const role = this._mapRole(msgType as string);
      const content = this._extractContent(msg.content);

      if (role === "system") {
        systemInstructions.push(
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content),
        );
        continue;
      }

      const parts: MessagePart[] = [];

      if (role === "tool") {
        const toolCallId =
          ((msg as unknown as Record<string, unknown>)
            .tool_call_id as string) || "";
        parts.push({
          type: "tool_call_response",
          id: toolCallId,
          response: content,
        });
      } else if (content) {
        parts.push({ type: "text", content });
      }

      const toolCalls = (msg as unknown as Record<string, unknown>)
        .tool_calls as Array<Record<string, unknown>> | undefined;
      if (toolCalls) {
        for (const tc of toolCalls) {
          parts.push({
            type: "tool_call",
            name: (tc.name || "") as string,
            id: (tc.id || "") as string,
            arguments:
              typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args),
          });
        }
      }

      if (parts.length > 0) {
        inputMessages.push({ role, parts });
      }
    }

    return { inputMessages, systemInstructions };
  }

  private _mapRole(msgType: string): "user" | "assistant" | "system" | "tool" {
    switch (msgType) {
      case "human":
        return "user";
      case "ai":
        return "assistant";
      case "system":
        return "system";
      case "tool":
        return "tool";
      default:
        return "user";
    }
  }

  private _extractContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part: unknown) => {
          const p = part as Record<string, unknown>;
          if (p.type === "text") return (p.text || "") as string;
          return "";
        })
        .filter(Boolean)
        .join("");
    }
    return String(content || "");
  }
}
