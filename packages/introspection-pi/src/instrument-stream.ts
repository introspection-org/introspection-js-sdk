/**
 * Wrap a pi-agent `StreamFn` so each invocation emits a `chat` span that
 * conforms to the OTEL GenAI semantic convention.
 */

import {
  context as otelContext,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context as OtelContext,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { GenAiSpanName } from "@introspection-sdk/types";
import {
  chatRequestAttributes,
  chatResponseAttributes,
  type AgentMeta,
} from "./attributes.js";

export interface InstrumentStreamOptions {
  /** Tracer to start the chat span on. */
  tracer: Tracer;
  /** Required metadata stamped onto every chat span. */
  meta: AgentMeta;
  /**
   * Returns the parent OTel context for the next chat span. If undefined or
   * returns null, `context.active()` is used at call time.
   */
  getParentContext?: () => OtelContext | null | undefined;
  /**
   * Caller-specific attributes (e.g. tenant labels, correlation IDs) layered
   * on top of the GenAI semconv attributes for each chat span.
   */
  extraAttributes?: (model: Model<string>, context: Context) => Attributes;
  /** Override the default span name builder. */
  spanName?: (model: Model<string>, context: Context) => string;
}

/**
 * Wrap a {@link StreamFn} to emit `chat ${provider}` spans.
 *
 * Reassign `agent.streamFn` with the result:
 *
 * ```ts
 * agent.streamFn = instrumentStream(agent.streamFn, { tracer, meta });
 * ```
 *
 * The wrapper preserves the {@link StreamFn} contract: errors thrown by the
 * underlying `streamFn` are surfaced through the returned event stream as
 * `error` events, never thrown synchronously.
 */
export function instrumentStream(
  streamFn: StreamFn,
  opts: InstrumentStreamOptions,
): StreamFn {
  const buildSpanName =
    opts.spanName ?? ((model) => GenAiSpanName.chat(model.provider));

  return ((model, context, options) => {
    const parentContext = opts.getParentContext?.() ?? otelContext.active();

    const span = opts.tracer.startSpan(
      buildSpanName(model, context),
      { kind: SpanKind.INTERNAL },
      parentContext ?? undefined,
    );

    span.setAttributes(chatRequestAttributes(model, context, opts.meta));
    const extra = opts.extraAttributes?.(model, context);
    if (extra) {
      span.setAttributes(extra);
    }

    const proxy = createAssistantMessageEventStream();
    const spanContext = trace.setSpan(
      parentContext ?? otelContext.active(),
      span,
    );

    void runUpstream({
      streamFn,
      model,
      context,
      options,
      spanContext,
      span,
      proxy,
    });

    return proxy;
  }) as StreamFn;
}

interface RunUpstreamArgs {
  streamFn: StreamFn;
  model: Model<string>;
  context: Context;
  options: Parameters<StreamFn>[2];
  spanContext: OtelContext;
  span: Span;
  proxy: AssistantMessageEventStream;
}

async function runUpstream({
  streamFn,
  model,
  context,
  options,
  spanContext,
  span,
  proxy,
}: RunUpstreamArgs): Promise<void> {
  let finished = false;

  try {
    const upstream = await otelContext.with(spanContext, () =>
      streamFn(model, context, options),
    );

    for await (const event of upstream) {
      proxy.push(event);
      if (!finished && (event.type === "done" || event.type === "error")) {
        finished = true;
        finishSpan(span, event);
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorEvent: Extract<AssistantMessageEvent, { type: "error" }> = {
      type: "error",
      reason: "error",
      error: assistantErrorMessage(model, errorMessage),
    };
    span.recordException(err instanceof Error ? err : new Error(errorMessage));
    proxy.push(errorEvent);
    if (!finished) {
      finished = true;
      finishSpan(span, errorEvent);
    }
  } finally {
    if (!finished) {
      // Upstream ended without a terminal event — close the span anyway so
      // we don't leak.
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
    }
  }
}

function finishSpan(
  span: Span,
  event: Extract<AssistantMessageEvent, { type: "done" | "error" }>,
): void {
  const message = event.type === "done" ? event.message : event.error;
  span.setAttributes(chatResponseAttributes(message));

  if (event.type === "error" || message.stopReason === "error") {
    const errorMessage = message.errorMessage ?? "Unknown error";
    span.recordException(new Error(errorMessage));
    span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }

  span.end();
}

function assistantErrorMessage(
  model: Model<string>,
  errorMessage: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  };
}
