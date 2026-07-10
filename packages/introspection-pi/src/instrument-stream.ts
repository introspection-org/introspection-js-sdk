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
  type Meter,
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
  GenAi,
  GenAiSpanName,
  IntrospectionAttr,
  type AbortTerminationReason,
} from "@introspection-sdk/types";
import {
  chatRequestAttributes,
  chatResponseAttributes,
  serverAttributes,
  type AgentMeta,
} from "./attributes.js";
import { classifyErrorType, classifyThrownErrorType } from "./error-type.js";
import { genAiMetrics, type GenAiMetrics } from "./metrics.js";

export interface InstrumentStreamOptions {
  /** Tracer to start the chat span on. */
  tracer: Tracer;
  /** Required metadata stamped onto every chat span. */
  meta: AgentMeta;
  /**
   * Optional meter. When set, the wrapper also records the GenAI client
   * metrics (`gen_ai.client.token.usage`, `gen_ai.client.operation.duration`,
   * `gen_ai.client.operation.time_to_first_chunk`,
   * `gen_ai.client.operation.time_per_output_chunk`).
   */
  meter?: Meter;
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
  /** Override the default span name builder (default: `chat {model.id}`). */
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
 * Wrap a {@link StreamFn} to emit `chat {model}` spans (CLIENT kind — the
 * model runs in a remote process).
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
    opts.spanName ?? ((model) => GenAiSpanName.chat(model.id));
  const metrics = opts.meter ? genAiMetrics(opts.meter) : undefined;

  return ((model, context, options) => {
    const parentContext = opts.getParentContext?.() ?? otelContext.active();

    // Compute the full attribute set up front and pass it at span creation
    // time so samplers see gen_ai.operation.name / provider / model /
    // server.*.
    const attributes: Attributes = {
      ...chatRequestAttributes(model, context, opts.meta, {
        compactionSummaries: opts.getCompactionSummaries?.(),
        streamOptions: options,
      }),
      ...opts.extraAttributes?.(model, context),
    };

    const span = opts.tracer.startSpan(
      buildSpanName(model, context),
      { kind: SpanKind.CLIENT, attributes },
      parentContext ?? undefined,
    );

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
      metrics,
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
  metrics?: GenAiMetrics;
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
  metrics,
  abortTerminationReason,
}: RunUpstreamArgs): Promise<void> {
  let finished = false;
  const startedAt = Date.now();
  const startedAtMonotonic = performance.now();
  let lastChunkAt: number | undefined;

  try {
    const upstream = await otelContext.with(spanContext, () =>
      streamFn(model, context, options),
    );

    for await (const event of upstream) {
      if (isOutputChunk(event)) {
        const now = performance.now();
        if (lastChunkAt === undefined) {
          const timeToFirstChunk = (now - startedAtMonotonic) / 1000;
          span.setAttribute(
            "gen_ai.response.time_to_first_chunk",
            timeToFirstChunk,
          );
          metrics?.timeToFirstChunk.record(
            timeToFirstChunk,
            chatMetricAttributes(model),
          );
        } else {
          metrics?.timePerOutputChunk.record(
            (now - lastChunkAt) / 1000,
            chatMetricAttributes(model),
          );
        }
        lastChunkAt = now;
      }
      proxy.push(event);
      if (!finished && (event.type === "done" || event.type === "error")) {
        finished = true;
        finishSpan({
          span,
          event,
          model,
          startedAt,
          metrics,
          abortTerminationReason,
        });
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorEvent: Extract<AssistantMessageEvent, { type: "error" }> = {
      type: "error",
      reason: options?.signal?.aborted === true ? "aborted" : "error",
      error: assistantErrorMessage(
        model,
        errorMessage,
        options?.signal?.aborted === true,
      ),
    };
    if (options?.signal?.aborted !== true) {
      recordGenAiException(span, err, classifyThrownErrorType(err));
    }
    proxy.push(errorEvent);
    if (!finished) {
      finished = true;
      finishSpan({
        span,
        event: errorEvent,
        model,
        startedAt,
        metrics,
        abortTerminationReason,
      });
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

function isOutputChunk(event: AssistantMessageEvent): boolean {
  return (
    (event.type === "text_delta" ||
      event.type === "thinking_delta" ||
      event.type === "toolcall_delta") &&
    event.delta.length > 0
  );
}

interface FinishSpanArgs {
  span: Span;
  event: Extract<AssistantMessageEvent, { type: "done" | "error" }>;
  model: Model<Api>;
  startedAt: number;
  metrics?: GenAiMetrics;
  abortTerminationReason?: () => AbortTerminationReason | null;
}

function finishSpan({
  span,
  event,
  model,
  startedAt,
  metrics,
  abortTerminationReason,
}: FinishSpanArgs): void {
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

  let errorType: string | undefined;
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
    errorType = classifyErrorType(errorMessage, "model_error");
    recordGenAiException(span, new Error(errorMessage), errorType);
    span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }

  if (metrics) {
    recordCompletionMetrics(metrics, model, message, startedAt, errorType);
  }

  span.end();
}

function chatMetricAttributes(model: Model<Api>): Attributes {
  return {
    [GenAi.OPERATION_NAME]: "chat",
    [GenAi.PROVIDER_NAME]: model.provider,
    [GenAi.REQUEST_MODEL]: model.id,
    ...serverAttributes(model.baseUrl),
  };
}

function recordCompletionMetrics(
  metrics: GenAiMetrics,
  model: Model<Api>,
  message: AssistantMessage,
  startedAt: number,
  errorType: string | undefined,
): void {
  const attributes = chatMetricAttributes(model);
  if (message.model) {
    attributes[GenAi.RESPONSE_MODEL] = message.model;
  }

  const durationAttributes = errorType
    ? { ...attributes, "error.type": errorType }
    : attributes;
  metrics.operationDuration.record(
    (Date.now() - startedAt) / 1000,
    durationAttributes,
  );

  // Cache-exclusive, matching the gen_ai.usage.input_tokens span attribute
  // (see chatResponseAttributes for why this deviates from semconv).
  if (message.usage.input > 0) {
    metrics.tokenUsage.record(message.usage.input, {
      ...attributes,
      "gen_ai.token.type": "input",
    });
  }
  if (message.usage.output > 0) {
    metrics.tokenUsage.record(message.usage.output, {
      ...attributes,
      "gen_ai.token.type": "output",
    });
  }
}

function recordGenAiException(
  span: Span,
  error: unknown,
  errorType: string,
): void {
  const exception = error instanceof Error ? error : new Error(String(error));
  span.setAttribute("error.type", errorType);
  // recordException writes the standard `exception` span event
  // (exception.type / exception.message / exception.stacktrace). The
  // semconv `gen_ai.client.operation.exception` signal is a *log* event —
  // duplicating it as a second span event is not part of the convention,
  // so only the standard exception event is recorded here.
  span.recordException(exception);
}

function assistantErrorMessage(
  model: Model<Api>,
  errorMessage: string,
  aborted = false,
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
    stopReason: aborted ? "aborted" : "error",
    errorMessage,
    timestamp: Date.now(),
  };
}
