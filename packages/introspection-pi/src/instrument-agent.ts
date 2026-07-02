/**
 * Subscribe to a pi-agent {@link Agent} to emit `execute_tool` spans for every
 * tool call the loop runs.
 */

import {
  context as otelContext,
  SpanKind,
  SpanStatusCode,
  type Attributes,
  type Context as OtelContext,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import { GenAiSpanName } from "@introspection-sdk/types";
import {
  executeToolAttributes,
  executeToolResultAttribute,
  type AgentMeta,
} from "./attributes.js";

export interface InstrumentAgentOptions {
  /** Tracer to start the execute_tool spans on. */
  tracer: Tracer;
  /** Required metadata stamped onto every execute_tool span. */
  meta: AgentMeta;
  /**
   * Returns the parent OTel context for the next tool span. If undefined or
   * returns null, `context.active()` is used at the time the start event fires.
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
  /** Stop subscribing and finalize any tool spans still open. */
  stop: () => void;
}

/**
 * Subscribe to {@link Agent.subscribe} and emit one `execute_tool ${name}`
 * span per tool call. Returns a handle whose `stop()` unsubscribes and
 * finalizes any still-open spans.
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
  const activeSpans = new Map<string, Span>();

  const unsubscribe = agent.subscribe((event, signal) => {
    handleEvent(event, opts, activeSpans, buildSpanName, signal);
  });

  return {
    stop: () => {
      unsubscribe();
      for (const span of activeSpans.values()) {
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      }
      activeSpans.clear();
    },
  };
}

/** Span attribute mirroring the invoke_agent turn span's termination vocabulary. */
const TERMINATION_REASON_ATTRIBUTE = "introspection.termination_reason";

function handleEvent(
  event: AgentEvent,
  opts: InstrumentAgentOptions,
  activeSpans: Map<string, Span>,
  buildSpanName: (toolName: string) => string,
  signal?: AbortSignal,
): void {
  switch (event.type) {
    case "tool_execution_start": {
      const parentContext = opts.getParentContext?.() ?? otelContext.active();

      const span = opts.tracer.startSpan(
        buildSpanName(event.toolName),
        { kind: SpanKind.INTERNAL },
        parentContext ?? undefined,
      );
      span.setAttributes(
        executeToolAttributes(
          event.toolName,
          event.toolCallId,
          event.args,
          opts.meta,
        ),
      );
      const extra = opts.extraAttributes?.(event);
      if (extra) {
        span.setAttributes(extra);
      }

      activeSpans.set(event.toolCallId, span);
      return;
    }

    case "tool_execution_end": {
      const span = activeSpans.get(event.toolCallId);
      if (!span) return;
      activeSpans.delete(event.toolCallId);

      span.setAttributes(executeToolResultAttribute(event.result));
      if (event.isError && signal?.aborted) {
        // The run's AbortSignal fired: pi synthesizes "Operation aborted"
        // error results for tool calls cut short by a requested abort. A
        // cancelled tool call is an outcome, not a failure — status stays
        // Unset, and the cancellation is queryable via the attribute.
        span.setAttribute(TERMINATION_REASON_ATTRIBUTE, "cancelled");
      } else if (event.isError) {
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
        span.setStatus({ code: SpanStatusCode.OK });
      }
      span.end();
      return;
    }

    default:
      return;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
