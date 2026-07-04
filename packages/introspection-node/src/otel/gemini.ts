/**
 * Lightweight Google Gemini (`@google/genai`) instrumentor for Introspection SDK.
 *
 * Captures the full Gemini response including per-part `thoughtSignature`
 * payloads (Gemini 3.x extended thinking) as gen_ai `thinking` parts with
 * `signature` set — mirroring how the {@link AnthropicInstrumentor} captures
 * Anthropic thinking blocks.
 *
 * Supports both non-streaming (`client.models.generateContent`) and streaming
 * (`client.models.generateContentStream`) calls.
 *
 * @example
 * ```ts
 * import { GoogleGenAI } from "@google/genai";
 * import { GeminiInstrumentor } from "@introspection-sdk/introspection-node";
 *
 * const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
 * new GeminiInstrumentor().instrument({ tracerProvider: provider, client });
 * // All client.models.generateContent / generateContentStream calls are now traced
 * ```
 *
 * @see https://ai.google.dev/gemini-api/docs/thought-signatures
 */

import { trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Tracer, Span } from "@opentelemetry/api";
import type { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";

import type { InputMessage, OutputMessage } from "@introspection-sdk/types";
import { providerCostAttributes } from "@introspection-sdk/types";
import {
  convertGeminiContentsToInputMessages,
  convertGeminiCandidatesToOutputMessages,
  convertGeminiSystemInstructionToSemconv,
  convertGeminiToolsToToolDefinitions,
  GEMINI_PROVIDER_NAME,
  type GeminiCandidate,
  type GeminiContent,
  type GeminiPart,
  type GeminiTool,
} from "../converters/gemini.js";

// ---------------------------------------------------------------------------
// Span helpers
// ---------------------------------------------------------------------------

function serializeMessages(msgs: InputMessage[] | OutputMessage[]): string {
  return JSON.stringify(
    msgs.map((m) => {
      const obj: Record<string, unknown> = { role: m.role, parts: m.parts };
      if ("finish_reason" in m && m.finish_reason) {
        obj.finish_reason = m.finish_reason;
      }
      return obj;
    }),
  );
}

function startSpan(
  tracer: Tracer,
  model: string,
  conversationId?: string,
): Span {
  return tracer.startSpan("chat", {
    kind: SpanKind.CLIENT,
    attributes: {
      "gen_ai.system": GEMINI_PROVIDER_NAME,
      "gen_ai.provider.name": GEMINI_PROVIDER_NAME,
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": model,
      "openinference.span.kind": "LLM",
      ...(conversationId
        ? { "gen_ai.conversation.id": conversationId }
        : undefined),
    },
  });
}

function setRequestAttrs(span: Span, kwargs: Record<string, unknown>): void {
  const contents = kwargs.contents as
    string | GeminiContent[] | GeminiContent | undefined;
  const inputMsgs = convertGeminiContentsToInputMessages(contents);
  if (inputMsgs.length > 0) {
    span.setAttribute("gen_ai.input.messages", serializeMessages(inputMsgs));
  }

  const config = (kwargs.config as Record<string, unknown> | undefined) || {};

  const systemInstruction = config.systemInstruction as
    string | GeminiContent | undefined;
  const systemInstructions =
    convertGeminiSystemInstructionToSemconv(systemInstruction);
  if (systemInstructions && systemInstructions.length > 0) {
    span.setAttribute(
      "gen_ai.system_instructions",
      JSON.stringify(systemInstructions),
    );
  }

  const tools = config.tools as GeminiTool[] | undefined;
  const toolDefs = convertGeminiToolsToToolDefinitions(tools);
  if (toolDefs && toolDefs.length > 0) {
    span.setAttribute("gen_ai.tool.definitions", JSON.stringify(toolDefs));
  }
}

function setUsageAttrs(
  span: Span,
  usage: Record<string, unknown> | undefined,
): void {
  if (!usage) return;
  const promptTokens = usage.promptTokenCount as number | undefined;
  const candidateTokens = usage.candidatesTokenCount as number | undefined;
  const cachedTokens = usage.cachedContentTokenCount as number | undefined;
  const thoughtTokens = usage.thoughtsTokenCount as number | undefined;
  if (typeof promptTokens === "number") {
    span.setAttribute("gen_ai.usage.input_tokens", promptTokens);
  }
  if (typeof candidateTokens === "number") {
    // Gemini reports candidatesTokenCount separately from thoughtsTokenCount;
    // sum them so output_tokens reflects everything billed as model output.
    const total = candidateTokens + (thoughtTokens ?? 0);
    span.setAttribute("gen_ai.usage.output_tokens", total);
  } else if (typeof thoughtTokens === "number") {
    span.setAttribute("gen_ai.usage.output_tokens", thoughtTokens);
  }
  if (typeof cachedTokens === "number") {
    span.setAttribute("gen_ai.usage.cache_read.input_tokens", cachedTokens);
  }
  // Provider-reported cost (e.g. OpenRouter usage.cost) when present.
  span.setAttributes(providerCostAttributes(usage));
}

function setResponseAttrs(span: Span, response: Record<string, unknown>): void {
  const candidates = response.candidates as GeminiCandidate[] | undefined;
  const outputMsgs = convertGeminiCandidatesToOutputMessages(candidates);
  if (outputMsgs.length > 0) {
    span.setAttribute("gen_ai.output.messages", serializeMessages(outputMsgs));
    const finishReasons = outputMsgs
      .map((m) => m.finish_reason)
      .filter((r): r is string => typeof r === "string");
    if (finishReasons.length > 0) {
      span.setAttribute("gen_ai.response.finish_reasons", finishReasons);
    }
  }

  const responseId = response.responseId as string | undefined;
  if (responseId) span.setAttribute("gen_ai.response.id", responseId);

  const modelVersion = response.modelVersion as string | undefined;
  if (modelVersion) span.setAttribute("gen_ai.response.model", modelVersion);

  setUsageAttrs(span, response.usageMetadata as Record<string, unknown>);

  span.setStatus({ code: SpanStatusCode.OK });
}

// ---------------------------------------------------------------------------
// Streaming aggregator
// ---------------------------------------------------------------------------

interface StreamChunk {
  candidates?: GeminiCandidate[];
  usageMetadata?: Record<string, unknown>;
  responseId?: string;
  modelVersion?: string;
}

/** True if a streamed part is just incremental text with no metadata to preserve. */
function isPlainTextPart(part: GeminiPart): boolean {
  return (
    typeof part.text === "string" &&
    part.thought !== true &&
    !part.thoughtSignature &&
    !part.functionCall &&
    !part.functionResponse
  );
}

/**
 * Async-iterable wrapper that aggregates streamed `GenerateContentResponse`
 * chunks so the underlying span captures the complete final message — including
 * the final per-part `thoughtSignature` values that only arrive on the last
 * chunk of a streamed turn.
 */
class TracedStream implements AsyncIterable<StreamChunk> {
  private aggregated: Map<number, GeminiCandidate> = new Map();
  private usage: Record<string, unknown> | undefined;
  private responseId: string | undefined;
  private modelVersion: string | undefined;
  private finalized = false;

  constructor(
    private readonly inner: AsyncIterable<StreamChunk>,
    private readonly span: Span,
  ) {}

  async *[Symbol.asyncIterator](): AsyncIterableIterator<StreamChunk> {
    try {
      for await (const chunk of this.inner) {
        this.processChunk(chunk);
        yield chunk;
      }
    } catch (err) {
      this.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: String(err),
      });
      this.span.end();
      this.finalized = true;
      throw err;
    } finally {
      this.finalize();
    }
  }

  private processChunk(chunk: StreamChunk): void {
    if (chunk.responseId) this.responseId = chunk.responseId;
    if (chunk.modelVersion) this.modelVersion = chunk.modelVersion;
    if (chunk.usageMetadata) this.usage = chunk.usageMetadata;
    for (const cand of chunk.candidates ?? []) {
      const idx = cand.index ?? 0;
      const existing = this.aggregated.get(idx);
      if (!existing) {
        this.aggregated.set(idx, {
          index: idx,
          finishReason: cand.finishReason,
          content: {
            role: cand.content?.role,
            parts: [...(cand.content?.parts ?? [])],
          },
        });
        continue;
      }
      if (cand.finishReason) existing.finishReason = cand.finishReason;
      if (cand.content?.role && !existing.content?.role) {
        existing.content!.role = cand.content.role;
      }
      this.mergeParts(
        existing.content!.parts as GeminiPart[],
        cand.content?.parts ?? [],
      );
    }
  }

  /**
   * Merge streamed parts into the aggregated parts list.
   *
   * Gemini streams text incrementally as separate `text`-only parts; thought
   * signatures and function calls arrive as their own parts. Consecutive
   * plain-text parts are coalesced into a single accumulating text part so the
   * final thought signature on a block survives on its trailing part.
   */
  private mergeParts(target: GeminiPart[], incoming: GeminiPart[]): void {
    for (const part of incoming) {
      const last = target[target.length - 1];
      if (isPlainTextPart(part) && last && isPlainTextPart(last)) {
        last.text = (last.text || "") + (part.text || "");
        continue;
      }
      target.push({ ...part });
    }
  }

  private finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    setResponseAttrs(this.span, {
      candidates: Array.from(this.aggregated.values()),
      usageMetadata: this.usage,
      responseId: this.responseId,
      modelVersion: this.modelVersion,
    });
    this.span.end();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// The instrumentor patches `client.models.generateContent[Stream]` in place.
// We accept the client as `any` (matching AnthropicInstrumentor) so the typed
// SDK shape from `@google/genai` is compatible without consumers needing
// to cast at the call site.
interface GeminiModelsApi {
  generateContent: (...args: unknown[]) => Promise<unknown>;
  generateContentStream?: (...args: unknown[]) => Promise<unknown>;
}

/**
 * Auto-instrumentor that wraps a `@google/genai` client instance to add
 * Introspection tracing with full thought-signature capture.
 *
 * Captures all content parts including thought summaries and signed
 * `thoughtSignature` payloads required for multi-turn replay.
 */
/**
 * Build the traced replacement for a non-streaming `generateContent`-style
 * method. Shared by {@link GeminiInstrumentor.instrument} (patches a client's
 * public `models.generateContent`) and {@link GeminiInstrumentor.instrumentClass}
 * (patches `Models.prototype.generateContentInternal` so every client is
 * auto-traced). Preserves the call-site `this`.
 */
function buildTracedGenerate(
  origGenerate: (...args: unknown[]) => Promise<unknown>,
  tracer: Tracer,
  conversationId: string,
): (...args: unknown[]) => Promise<unknown> {
  return async function tracedGenerate(this: unknown, ...args: unknown[]) {
    const kwargs = (args[0] as Record<string, unknown>) || {};
    const span = startSpan(
      tracer,
      (kwargs.model as string) || "unknown",
      conversationId,
    );
    setRequestAttrs(span, kwargs);
    try {
      const response = (await origGenerate.apply(this, args)) as Record<
        string,
        unknown
      >;
      setResponseAttrs(span, response);
      return response;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  };
}

/** Build the traced replacement for a streaming `generateContentStream`-style method. */
function buildTracedGenerateStream(
  origStream: (...args: unknown[]) => Promise<unknown>,
  tracer: Tracer,
  conversationId: string,
): (...args: unknown[]) => Promise<unknown> {
  return async function tracedGenerateStream(
    this: unknown,
    ...args: unknown[]
  ) {
    const kwargs = (args[0] as Record<string, unknown>) || {};
    const span = startSpan(
      tracer,
      (kwargs.model as string) || "unknown",
      conversationId,
    );
    setRequestAttrs(span, kwargs);
    try {
      const stream = (await origStream.apply(
        this,
        args,
      )) as AsyncIterable<StreamChunk>;
      return new TracedStream(stream, span);
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      span.end();
      throw err;
    }
  };
}

/**
 * Marker placed on a patched `Models.prototype` method so repeated
 * `instrumentClass()` calls (e.g. a second `introspection.init()`) are no-ops.
 */
const PATCHED = Symbol.for("introspection.gemini.patched");

export class GeminiInstrumentor {
  private tracer: Tracer | null = null;
  private restores: Array<() => void> = [];
  private conversationId: string | undefined;

  instrument(opts: {
    tracerProvider?: BasicTracerProvider;
    /** A `@google/genai` `GoogleGenAI` client instance. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any;
    /**
     * Conversation ID shared across all spans produced by this instrumentor.
     * Defaults to a random UUID generated at `instrument()` time.
     */
    conversationId?: string;
  }): void {
    const { client } = opts;
    if (!client?.models?.generateContent) {
      throw new Error(
        "Invalid client — pass a GoogleGenAI client instance (new GoogleGenAI({...}))",
      );
    }

    this.conversationId = opts.conversationId ?? crypto.randomUUID();

    const provider = opts.tracerProvider ?? trace.getTracerProvider();
    this.tracer = (provider as BasicTracerProvider).getTracer(
      "introspection-gemini",
    );
    const tracer = this.tracer;
    const conversationId = this.conversationId;

    const api = client.models as GeminiModelsApi;
    const origGenerate = api.generateContent.bind(api);
    const origGenerateStream = api.generateContentStream?.bind(api);
    this.restores.push(() => {
      api.generateContent = origGenerate;
      if (origGenerateStream) api.generateContentStream = origGenerateStream;
    });

    api.generateContent = buildTracedGenerate(
      origGenerate,
      tracer,
      conversationId,
    ) as GeminiModelsApi["generateContent"];

    if (origGenerateStream) {
      api.generateContentStream = buildTracedGenerateStream(
        origGenerateStream,
        tracer,
        conversationId,
      ) as GeminiModelsApi["generateContentStream"];
    }
  }

  /**
   * Patch `Models.prototype.generateContentInternal` / `…StreamInternal` so
   * **every** `GoogleGenAI` client is traced — the one-liner path used by
   * `introspection.init()`. The public `generateContent` /
   * `generateContentStream` are per-instance bound class fields that delegate
   * to these prototype methods, so patching the prototype covers all clients.
   * Idempotent: a second call is a no-op.
   *
   * @param opts.genai The `@google/genai` module (must expose `Models`).
   */
  instrumentClass(opts: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    genai: any;
    tracerProvider?: BasicTracerProvider;
    conversationId?: string;
  }): void {
    const proto = opts.genai?.Models?.prototype;
    if (typeof proto?.generateContentInternal !== "function") {
      throw new Error(
        "Invalid @google/genai module — expected `Models.prototype.generateContentInternal`",
      );
    }
    if (proto.generateContentInternal[PATCHED]) return;

    this.conversationId = opts.conversationId ?? crypto.randomUUID();
    const provider = opts.tracerProvider ?? trace.getTracerProvider();
    this.tracer = (provider as BasicTracerProvider).getTracer(
      "introspection-gemini",
    );
    const conversationId = this.conversationId;

    const origGenerate = proto.generateContentInternal;
    const patchedGenerate = buildTracedGenerate(
      origGenerate,
      this.tracer,
      conversationId,
    ) as ((...args: unknown[]) => Promise<unknown>) & { [PATCHED]?: boolean };
    patchedGenerate[PATCHED] = true;
    proto.generateContentInternal = patchedGenerate;
    this.restores.push(() => {
      proto.generateContentInternal = origGenerate;
    });

    if (typeof proto.generateContentStreamInternal === "function") {
      const origStream = proto.generateContentStreamInternal;
      const patchedStream = buildTracedGenerateStream(
        origStream,
        this.tracer,
        conversationId,
      ) as ((...args: unknown[]) => Promise<unknown>) & { [PATCHED]?: boolean };
      patchedStream[PATCHED] = true;
      proto.generateContentStreamInternal = patchedStream;
      this.restores.push(() => {
        proto.generateContentStreamInternal = origStream;
      });
    }
  }

  uninstrument(): void {
    for (const restore of this.restores) restore();
    this.restores = [];
    this.tracer = null;
  }
}
