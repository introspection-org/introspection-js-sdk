/**
 * Subscribe to a pi-agent {@link Agent} to emit `execute_tool` spans for every
 * tool call the loop runs, and (optionally) one `invoke_agent` span per run.
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
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import {
  GenAi,
  GenAiSpanName,
  IntrospectionAttr,
} from "@introspection-sdk/types";
import {
  executeToolAttributes,
  executeToolResultAttribute,
  invokeAgentAttributes,
  type AgentMeta,
} from "./attributes.js";
import { semconvFinishReason } from "./convert.js";
import { classifyErrorType } from "./error-type.js";
import { genAiMetrics, type GenAiMetrics } from "./metrics.js";

export interface InstrumentAgentOptions {
  /** Tracer to start the execute_tool spans on. */
  tracer: Tracer;
  /** Required metadata stamped onto every execute_tool span. */
  meta: AgentMeta;
  /**
   * Optional meter. When set, the wrapper also records
   * `gen_ai.execute_tool.duration` per tool call and (when `runSpans` is
   * enabled) `gen_ai.invoke_agent.duration` per run.
   */
  meter?: Meter;
  /**
   * Emit one `invoke_agent {agent.name}` span per agent run
   * (`agent_start` → `agent_end`), carrying conversation/agent identity,
   * aggregated token usage, and the final finish reason.
   *
   * Off by default: hosts that already create their own turn/run spans
   * (and parent chat spans onto them via `getParentContext`) would get
   * duplicate run spans otherwise. When enabled, wire the chat spans under
   * the run span with
   * `instrumentStream(fn, { getParentContext: () => handle.getRunContext() })`;
   * tool spans parent onto the run span automatically unless
   * `getParentContext` is provided.
   */
  runSpans?: boolean;
  /**
   * Returns the parent OTel context for the next tool span. If undefined or
   * returns null, the active run span (when `runSpans` is enabled) or
   * `context.active()` is used at the time the start event fires.
   */
  getParentContext?: () => OtelContext | null | undefined;
  /**
   * Caller-specific attributes (e.g. tenant labels, correlation IDs) layered
   * on top of the GenAI semconv attributes for each tool span.
   */
  extraAttributes?: (
    event: Extract<AgentEvent, { type: "tool_execution_start" }>,
  ) => Attributes;
  /** Override the default span name builder. */
  spanName?: (toolName: string) => string;
}

export interface AgentInstrumentation {
  /** Stop subscribing and finalize any spans still open. */
  stop: () => void;
  /**
   * OTel context of the active `invoke_agent` span, when `runSpans` is
   * enabled and a run is in flight. Pass to `instrumentStream`'s
   * `getParentContext` so chat spans nest under the run span.
   */
  getRunContext: () => OtelContext | undefined;
}

interface ActiveToolSpan {
  span: Span;
  startedAt: number;
}

interface ActiveRun {
  span: Span;
  context: OtelContext;
  startedAt: number;
  inputTokens: number;
  outputTokens: number;
  sawUsage: boolean;
  lastStopReason?: string;
  errorMessage?: string;
}

/**
 * Subscribe to {@link Agent.subscribe} and emit one `execute_tool ${name}`
 * span per tool call (plus one `invoke_agent` span per run when enabled).
 * Returns a handle whose `stop()` unsubscribes and finalizes any still-open
 * spans.
 *
 * Tool call IDs are assumed unique per agent run; concurrent tool execution
 * (`ToolExecutionMode = "parallel"`) is supported because each id keys its
 * own span entry.
 */
export function instrumentAgent(
  agent: Agent,
  opts: InstrumentAgentOptions,
): AgentInstrumentation {
  const buildSpanName = opts.spanName ?? GenAiSpanName.executeTool;
  const activeSpans = new Map<string, ActiveToolSpan>();
  const metrics = opts.meter ? genAiMetrics(opts.meter) : undefined;
  const state: { run: ActiveRun | undefined } = { run: undefined };

  const unsubscribe = agent.subscribe((event, signal) => {
    handleEvent(
      event,
      agent,
      opts,
      activeSpans,
      state,
      metrics,
      buildSpanName,
      signal,
    );
  });

  return {
    stop: () => {
      unsubscribe();
      for (const { span } of activeSpans.values()) {
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      }
      activeSpans.clear();
      if (state.run) {
        state.run.span.setStatus({ code: SpanStatusCode.OK });
        state.run.span.end();
        state.run = undefined;
      }
    },
    getRunContext: () => state.run?.context,
  };
}

function handleEvent(
  event: AgentEvent,
  agent: Agent,
  opts: InstrumentAgentOptions,
  activeSpans: Map<string, ActiveToolSpan>,
  state: { run: ActiveRun | undefined },
  metrics: GenAiMetrics | undefined,
  buildSpanName: (toolName: string) => string,
  signal?: AbortSignal,
): void {
  switch (event.type) {
    case "agent_start": {
      if (!opts.runSpans) return;
      const parentContext = opts.getParentContext?.() ?? otelContext.active();
      const span = opts.tracer.startSpan(
        GenAiSpanName.invokeAgent(opts.meta.agentName),
        {
          kind: SpanKind.INTERNAL,
          attributes: invokeAgentAttributes(opts.meta),
        },
        parentContext ?? undefined,
      );
      state.run = {
        span,
        context: trace.setSpan(parentContext ?? otelContext.active(), span),
        startedAt: Date.now(),
        inputTokens: 0,
        outputTokens: 0,
        sawUsage: false,
      };
      return;
    }

    case "message_end": {
      const run = state.run;
      const message = event.message;
      if (!run || message.role !== "assistant" || !("usage" in message)) {
        return;
      }
      // Semconv: input token counts include cache reads/writes.
      run.inputTokens +=
        message.usage.input +
        message.usage.cacheRead +
        message.usage.cacheWrite;
      run.outputTokens += message.usage.output;
      run.sawUsage = true;
      run.lastStopReason = message.stopReason;
      run.errorMessage = message.errorMessage;
      return;
    }

    case "agent_end": {
      const run = state.run;
      if (!run) return;
      state.run = undefined;
      finishRunSpan(run, opts.meta, metrics, signal);
      return;
    }

    case "tool_execution_start": {
      const parentContext =
        opts.getParentContext?.() ?? state.run?.context ?? otelContext.active();

      const description = lookupToolDescription(agent, event.toolName);

      // Full attribute set at span creation time so samplers see
      // gen_ai.operation.name / tool.name / tool.type.
      const attributes: Attributes = {
        ...executeToolAttributes(
          event.toolName,
          event.toolCallId,
          event.args,
          opts.meta,
          description,
        ),
        ...opts.extraAttributes?.(event),
      };

      const span = opts.tracer.startSpan(
        buildSpanName(event.toolName),
        { kind: SpanKind.INTERNAL, attributes },
        parentContext ?? undefined,
      );

      activeSpans.set(event.toolCallId, { span, startedAt: Date.now() });
      return;
    }

    case "tool_execution_end": {
      const active = activeSpans.get(event.toolCallId);
      if (!active) return;
      activeSpans.delete(event.toolCallId);
      const { span, startedAt } = active;

      let errorType: string | undefined;
      if (event.isError && signal?.aborted) {
        // The run's AbortSignal fired: pi synthesizes "Operation aborted"
        // error results for tool calls cut short by a requested abort. A
        // cancelled tool call is an outcome, not a failure — status stays
        // Unset, and the cancellation is queryable via the attribute.
        span.setAttribute(IntrospectionAttr.TERMINATION_REASON, "cancelled");
      } else if (event.isError) {
        errorType = "tool_error";
        span.setAttribute("error.type", errorType);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message:
            typeof event.result === "string"
              ? event.result
              : event.result !== undefined
                ? safeStringify(event.result)
                : undefined,
        });
      } else {
        // Semconv scopes gen_ai.tool.call.result to successful executions;
        // error text is carried on the span status instead.
        span.setAttributes(executeToolResultAttribute(event.result));
        span.setStatus({ code: SpanStatusCode.OK });
      }
      span.end();

      if (metrics) {
        const attributes: Attributes = {
          [GenAi.TOOL_NAME]: event.toolName,
          [GenAi.TOOL_TYPE]: "function",
          [GenAi.AGENT_NAME]: opts.meta.agentName,
        };
        if (errorType) attributes["error.type"] = errorType;
        metrics.executeToolDuration.record(
          (Date.now() - startedAt) / 1000,
          attributes,
        );
      }
      return;
    }

    default:
      return;
  }
}

function finishRunSpan(
  run: ActiveRun,
  meta: AgentMeta,
  metrics: GenAiMetrics | undefined,
  signal?: AbortSignal,
): void {
  const { span } = run;

  if (run.sawUsage) {
    span.setAttribute(GenAi.USAGE_INPUT_TOKENS, run.inputTokens);
    span.setAttribute(GenAi.USAGE_OUTPUT_TOKENS, run.outputTokens);
  }
  if (run.lastStopReason) {
    span.setAttribute(GenAi.RESPONSE_FINISH_REASONS, [
      semconvFinishReason(run.lastStopReason),
    ]);
  }

  let errorType: string | undefined;
  const aborted = run.lastStopReason === "aborted" || signal?.aborted === true;
  if (aborted) {
    // Mirrors the chat-span contract: a requested cancellation is an
    // outcome, not a failure.
    span.setAttribute(IntrospectionAttr.TERMINATION_REASON, "cancelled");
  } else if (run.lastStopReason === "error") {
    const errorMessage = run.errorMessage ?? "Unknown error";
    errorType = classifyErrorType(errorMessage, "model_error");
    span.setAttribute("error.type", errorType);
    span.recordException(new Error(errorMessage));
    span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }
  span.end();

  if (metrics) {
    const attributes: Attributes = { [GenAi.AGENT_NAME]: meta.agentName };
    if (errorType) attributes["error.type"] = errorType;
    metrics.invokeAgentDuration.record(
      (Date.now() - run.startedAt) / 1000,
      attributes,
    );
  }
}

/**
 * Best-effort `gen_ai.tool.description` lookup from the agent's tool
 * registry. Defensive against partial Agent implementations (tests, mocks)
 * that don't expose `state.tools`.
 */
function lookupToolDescription(
  agent: Agent,
  toolName: string,
): string | undefined {
  try {
    return agent.state?.tools?.find((tool) => tool.name === toolName)
      ?.description;
  } catch {
    return undefined;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
