/**
 * Lightweight Anthropic instrumentor for Introspection SDK.
 *
 * Captures the full Anthropic response including thinking blocks (extended
 * thinking) with signatures, which third-party instrumentors drop.
 *
 * Supports both non-streaming (`messages.create`) and streaming
 * (`messages.create({ stream: true })`) calls.
 *
 * @example
 * ```ts
 * import { AnthropicInstrumentor } from "@introspection-sdk/introspection-node";
 *
 * const instrumentor = new AnthropicInstrumentor();
 * instrumentor.instrument({ tracerProvider: provider });
 * // All client.messages.create calls are now traced
 * ```
 */

import type {
  InputMessage,
  OutputMessage,
  MessagePart,
  ReasoningPart,
} from "./types/genai.js";

import { trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Tracer, Span } from "@opentelemetry/api";
import type { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";

// ---------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------

/** Sentinel value for redacted thinking blocks — content was encrypted by safety systems. */
export const REDACTED_THINKING_CONTENT = "[redacted]";

function blockToParts(block: Record<string, unknown>): MessagePart[] {
  const bt = (block.type as string) || "";

  if (bt === "text") {
    return [{ type: "text", content: (block.text as string) || "" }];
  }

  if (bt === "thinking") {
    const part: ReasoningPart = {
      type: "thinking",
      content: (block.thinking as string) || undefined,
      signature: (block.signature as string) || undefined,
      provider_name: "anthropic",
    };
    return [part];
  }

  if (bt === "redacted_thinking") {
    return [
      {
        type: "thinking",
        content: REDACTED_THINKING_CONTENT,
        signature: (block.data as string) || undefined,
        provider_name: "anthropic",
      } as ReasoningPart,
    ];
  }

  if (bt === "tool_use") {
    return [
      {
        type: "tool_call",
        id: (block.id as string) || "",
        name: (block.name as string) || "",
        arguments: block.input,
      },
    ];
  }

  if (bt === "tool_result") {
    return [
      {
        type: "tool_call_response",
        id: (block.tool_use_id as string) || "",
        response: block.content != null ? String(block.content) : "",
      },
    ];
  }

  return [];
}

function convertAnthropicInput(
  messages: Array<Record<string, unknown>>,
): InputMessage[] {
  const result: InputMessage[] = [];
  for (const msg of messages) {
    const role = (msg.role as string) || "user";
    const content = msg.content;
    if (typeof content === "string") {
      result.push({
        role: role as InputMessage["role"],
        parts: [{ type: "text", content }],
      });
    } else if (Array.isArray(content)) {
      const parts: MessagePart[] = [];
      for (const block of content) {
        const rec =
          typeof block === "object" && block !== null
            ? (block as Record<string, unknown>)
            : { type: "text", text: String(block) };
        parts.push(...blockToParts(rec));
      }
      if (parts.length > 0) {
        result.push({ role: role as InputMessage["role"], parts });
      }
    }
  }
  return result;
}

function convertAnthropicOutput(
  content: Array<Record<string, unknown>>,
): OutputMessage[] {
  const parts: MessagePart[] = [];
  let hasToolCalls = false;
  for (const block of content) {
    const newParts = blockToParts(block);
    for (const p of newParts) {
      if (p.type === "tool_call") hasToolCalls = true;
    }
    parts.push(...newParts);
  }
  if (parts.length === 0) return [];
  return [
    {
      role: "assistant",
      parts,
      finish_reason: hasToolCalls ? "tool-calls" : "stop",
    },
  ];
}

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

function startSpan(tracer: Tracer, model: string): { span: Span; token: null } {
  const span = tracer.startSpan("chat", {
    kind: SpanKind.CLIENT,
    attributes: {
      "gen_ai.system": "anthropic",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": model,
      "openinference.span.kind": "LLM",
    },
  });
  return { span, token: null };
}

function setRequestAttrs(span: Span, kwargs: Record<string, unknown>): void {
  const messages = (kwargs.messages as Array<Record<string, unknown>>) || [];
  const inputMsgs = convertAnthropicInput(messages);
  if (inputMsgs.length > 0) {
    span.setAttribute("gen_ai.input.messages", serializeMessages(inputMsgs));
  }

  const system = kwargs.system;
  if (system) {
    const sysVal =
      typeof system === "string"
        ? JSON.stringify([{ type: "text", content: system }])
        : JSON.stringify(system);
    span.setAttribute("gen_ai.system_instructions", sysVal);
  }

  const tools = kwargs.tools as Array<Record<string, unknown>> | undefined;
  if (tools && tools.length > 0) {
    const defs = tools.map((t) => ({
      name: t.name || "",
      description: t.description,
      parameters: t.input_schema,
    }));
    span.setAttribute("gen_ai.tool.definitions", JSON.stringify(defs));
  }
}

function setResponseAttrs(span: Span, response: Record<string, unknown>): void {
  const content = response.content as
    | Array<Record<string, unknown>>
    | undefined;
  if (content) {
    const outputMsgs = convertAnthropicOutput(content);
    if (outputMsgs.length > 0) {
      span.setAttribute(
        "gen_ai.output.messages",
        serializeMessages(outputMsgs),
      );
    }
  }

  if (response.id) span.setAttribute("gen_ai.response.id", String(response.id));
  if (response.model)
    span.setAttribute("gen_ai.response.model", String(response.model));

  const usage = response.usage as Record<string, number> | undefined;
  if (usage) {
    if (usage.input_tokens != null)
      span.setAttribute("gen_ai.usage.input_tokens", usage.input_tokens);
    if (usage.output_tokens != null)
      span.setAttribute("gen_ai.usage.output_tokens", usage.output_tokens);
  }

  span.setStatus({ code: SpanStatusCode.OK });
}

// ---------------------------------------------------------------------------
// Stream wrapper
// ---------------------------------------------------------------------------

interface StreamEvent {
  type: string;
  message?: Record<string, unknown>;
  content_block?: Record<string, unknown>;
  delta?: Record<string, unknown>;
  index?: number;
}

class TracedStream {
  private inner: AsyncIterable<StreamEvent>;
  private span: Span;
  private blocks: Array<Record<string, unknown>> = [];
  private currentBlock: Record<string, unknown> | null = null;
  private responseId: string | null = null;
  private responseModel: string | null = null;
  private inputTokens = 0;
  private outputTokens = 0;
  private finalized = false;

  constructor(inner: AsyncIterable<StreamEvent>, span: Span) {
    this.inner = inner;
    this.span = span;
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<StreamEvent> {
    try {
      for await (const event of this.inner) {
        this.processEvent(event);
        yield event;
      }
    } finally {
      this.finalize();
    }
  }

  private processEvent(event: StreamEvent): void {
    if (event.type === "message_start" && event.message) {
      this.responseId = (event.message.id as string) || null;
      this.responseModel = (event.message.model as string) || null;
      const usage = event.message.usage as Record<string, number> | undefined;
      if (usage) this.inputTokens = usage.input_tokens || 0;
    } else if (event.type === "content_block_start" && event.content_block) {
      const bt = (event.content_block.type as string) || "";
      this.currentBlock = { type: bt };
      if (bt === "thinking") {
        this.currentBlock.thinking = "";
        this.currentBlock.signature = "";
      } else if (bt === "text") {
        this.currentBlock.text = "";
      }
    } else if (event.type === "content_block_delta" && event.delta) {
      if (!this.currentBlock) return;
      const dt = (event.delta.type as string) || "";
      if (dt === "thinking_delta") {
        this.currentBlock.thinking =
          ((this.currentBlock.thinking as string) || "") +
          ((event.delta.thinking as string) || "");
      } else if (dt === "text_delta") {
        this.currentBlock.text =
          ((this.currentBlock.text as string) || "") +
          ((event.delta.text as string) || "");
      } else if (dt === "signature_delta") {
        this.currentBlock.signature =
          ((this.currentBlock.signature as string) || "") +
          ((event.delta.signature as string) || "");
      }
    } else if (event.type === "content_block_stop") {
      if (this.currentBlock) {
        this.blocks.push(this.currentBlock);
        this.currentBlock = null;
      }
    } else if (event.type === "message_delta") {
      const usage = (event as unknown as Record<string, unknown>).usage as
        | Record<string, number>
        | undefined;
      if (usage) this.outputTokens = usage.output_tokens || 0;
    }
  }

  private finalize(): void {
    if (this.finalized) return;
    this.finalized = true;

    if (this.blocks.length > 0) {
      const outputMsgs = convertAnthropicOutput(this.blocks);
      if (outputMsgs.length > 0) {
        this.span.setAttribute(
          "gen_ai.output.messages",
          serializeMessages(outputMsgs),
        );
      }
    }
    if (this.responseId)
      this.span.setAttribute("gen_ai.response.id", this.responseId);
    if (this.responseModel)
      this.span.setAttribute("gen_ai.response.model", this.responseModel);
    if (this.inputTokens)
      this.span.setAttribute("gen_ai.usage.input_tokens", this.inputTokens);
    if (this.outputTokens)
      this.span.setAttribute("gen_ai.usage.output_tokens", this.outputTokens);
    this.span.setStatus({ code: SpanStatusCode.OK });
    this.span.end();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Traced wrapper around `client.messages.create(kwargs)`.
 * Creates a gen_ai span with full Anthropic response including thinking blocks.
 */
export async function tracedMessagesCreate(
  tracer: Tracer,
  client: { messages: { create: (...args: unknown[]) => Promise<unknown> } },
  kwargs: Record<string, unknown>,
): Promise<unknown> {
  const { span } = startSpan(tracer, (kwargs.model as string) || "unknown");
  try {
    setRequestAttrs(span, kwargs);
    const response = (await client.messages.create(kwargs)) as Record<
      string,
      unknown
    >;
    setResponseAttrs(span, response);
    return response;
  } catch (e) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: String(e),
    });
    throw e;
  } finally {
    span.end();
  }
}

/**
 * Auto-instrumentor that patches `Anthropic.messages.create` to add tracing.
 *
 * Captures all content blocks including thinking (extended thinking) with
 * signatures. Supports both non-streaming and streaming calls.
 */
/**
 * Auto-instrumentor that wraps an Anthropic client instance to add tracing.
 *
 * Captures all content blocks including thinking (extended thinking) with
 * signatures. Supports both non-streaming and streaming calls.
 */
export class AnthropicInstrumentor {
  private tracer: Tracer | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private patchedClients: Array<{ client: any; originalCreate: any }> = [];

  instrument(opts: {
    tracerProvider?: BasicTracerProvider;
    /** The Anthropic client instance to instrument. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any;
  }): void {
    const { client } = opts;
    if (!client?.messages?.create) {
      throw new Error(
        "Invalid client — pass an Anthropic client instance (new Anthropic())",
      );
    }

    const provider = opts.tracerProvider ?? trace.getTracerProvider();
    this.tracer = (provider as BasicTracerProvider).getTracer(
      "introspection-anthropic",
    );

    const origCreate = client.messages.create.bind(client.messages);
    this.patchedClients.push({ client, originalCreate: origCreate });
    const tracer = this.tracer!;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client.messages.create = function (...args: any[]) {
      const kwargs = args[0] as Record<string, unknown>;
      const isStream = kwargs?.stream === true;

      const { span } = startSpan(
        tracer,
        (kwargs?.model as string) || "unknown",
      );
      setRequestAttrs(span, kwargs || {});

      if (isStream) {
        const streamPromise = origCreate(...args) as Promise<
          AsyncIterable<StreamEvent>
        >;
        return streamPromise.then(
          (stream: AsyncIterable<StreamEvent>) =>
            new TracedStream(stream, span),
          (err: Error) => {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: String(err),
            });
            span.end();
            throw err;
          },
        );
      }

      const resultPromise = origCreate(...args) as Promise<
        Record<string, unknown>
      >;
      return resultPromise.then(
        (response: Record<string, unknown>) => {
          setResponseAttrs(span, response);
          span.end();
          return response;
        },
        (err: Error) => {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: String(err),
          });
          span.end();
          throw err;
        },
      );
    };
  }

  uninstrument(): void {
    for (const { client, originalCreate } of this.patchedClients) {
      client.messages.create = originalCreate;
    }
    this.patchedClients = [];
    this.tracer = null;
  }
}
