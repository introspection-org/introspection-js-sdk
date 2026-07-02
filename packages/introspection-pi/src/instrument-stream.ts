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
  type Api,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  GenAiSpanName,
  IntrospectionAttr,
  type AbortTerminationReason,
} from "@introspection-sdk/types";
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
  extraAttributes?: (model: Model<Api>, context: Context) => Attributes;
  /** Override the default span name builder. */
  spanName?: (model: Model<Api>, context: Context) => string;
  /**
   * Returns the compaction summaries known for the session, read at span
   * time so summaries created mid-session are picked up. Source them
   * structurally from pi's session tree —
   * `session.sessionManager.getEntries()` filtered to
   * `type === "compaction"`, mapped to `summary` — so detection does not
   * depend on the prose wrapper pi renders around the summary.
   */
  getCompactionSummaries?: () => readonly string[];
  /**
   * Classify a stream that ended with stop reason `"aborted"` (the caller's
   * AbortSignal fired mid-generation; pi never maps provider timeouts to
   * `"aborted"`). Called at span end. Return the
   * `introspection.termination_reason` to stamp on the span —
   * `"cancelled"` (user/runtime stop) or `"awaiting_user"` (paused for an
   * interrupt) — and the span ends with status Unset and no exception:
   * a requested cancellation is an outcome, not a failure. Return `null`
   * to keep the abort classified as an error (the host did not request
   * this cancellation). When omitted, aborts default to `"cancelled"`.
   */
  abortTerminationReason?: () => AbortTerminationReason | null;
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

    span.setAttributes(
      chatRequestAttributes(model, context, opts.meta, {
        compactionSummaries: opts.getCompactionSummaries?.(),
      }),
    );
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
      abortTerminationReason: opts.abortTerminationReason,
    });

    return proxy;
  }) as StreamFn;
}

interface RunUpstreamArgs {
  streamFn: StreamFn;
  model: Model<Api>;
  context: Context;
  options: Parameters<StreamFn>[2];
  spanContext: OtelContext;
  span: Span;
  proxy: AssistantMessageEventStream;
  abortTerminationReason?: () => AbortTerminationReason | null;
}

async function runUpstream({
  streamFn,
  model,
  context,
  options,
  spanContext,
  span,
  proxy,
  abortTerminationReason,
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
        finishSpan(span, event, abortTerminationReason);
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
      finishSpan(span, errorEvent, abortTerminationReason);
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
  abortTerminationReason?: () => AbortTerminationReason | null,
): void {
  const message = event.type === "done" ? event.message : event.error;
  span.setAttributes(chatResponseAttributes(message));

  const aborted =
    (event.type === "error" && event.reason === "aborted") ||
    message.stopReason === "aborted";
  const terminationReason = !aborted
    ? null
    : abortTerminationReason
      ? abortTerminationReason()
      : "cancelled";

  if (terminationReason !== null) {
    // A requested cancellation is an outcome, not a failure: status stays
    // Unset (no success assertion over a truncated generation, no error),
    // no synthetic exception. finish_reasons=["aborted"] is already on the
    // span via chatResponseAttributes.
    span.setAttribute(IntrospectionAttr.TERMINATION_REASON, terminationReason);
  } else if (
    aborted ||
    event.type === "error" ||
    message.stopReason === "error"
  ) {
    // An aborted stream lands here only when the host did not claim the
    // abort (callback returned null) — fail toward a false error, never a
    // hidden one.
    const errorMessage = message.errorMessage ?? "Unknown error";
    span.recordException(new Error(errorMessage));
    span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }

  span.end();
}

function assistantErrorMessage(
  model: Model<Api>,
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
