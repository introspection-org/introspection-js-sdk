/**
 * Normalized trajectory records to OpenTelemetry GenAI spans.
 *
 * The span shape mirrors how a turn actually executes, because that is what
 * makes the result readable next to the rest of a tenant's GenAI telemetry:
 *
 *     invoke_agent <host>                 one turn — the root
 *     ├── chat <model>                    one per assistant message
 *     └── execute_tool <name>             one per tool call, closed by its result
 *
 * Every span is stamped with the record's **own** timestamp rather than the
 * moment of capture. Capture runs at the end of a turn, so wall-clock-at-export
 * would collapse a multi-minute turn into a few milliseconds and make every
 * duration in the resulting telemetry a lie.
 *
 * Content is gated by {@link ContentCapture}. At `metadata` the spans carry
 * structure, timings, models, and tool *names* — enough to see that a workflow
 * stalled on a particular tool — and no message bodies or tool payloads. The
 * gate is applied here, at the point of construction, so there is no path where
 * unconsented content reaches a span and is filtered later.
 */
import {
  context as otelContext,
  trace as otelTrace,
  SpanKind,
  SpanStatusCode,
  type Attributes,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import type {
  NormalizedRecord,
  NormalizedTranscript,
} from "@letta-ai/trajectory";

import type { CaptureHost, ContentCapture } from "./config.js";
import { providerForHost, type HostInfo } from "./host.js";
import { SERVICE_NAME, VERSION } from "./version.js";

/** Everything the converter needs beyond the records themselves. */
export interface TurnContext {
  /** Host-stable session id — becomes `gen_ai.conversation.id`. */
  sessionId: string;
  /** Host identity and version, from {@link readHostInfo}. */
  hostInfo: HostInfo;
  /** Consented content level. */
  content: ContentCapture;
  /** Zero-based turn ordinal within the session. */
  turn: number;
}

/** What a conversion produced, for the caller's logging. */
export interface TurnSpans {
  /** Number of spans created (turn + chat + tool). */
  spanCount: number;
  /** Model observed for the turn, when the records named one. */
  model?: string;
}

/**
 * Cap on a single captured content attribute, in characters.
 *
 * Transcripts routinely contain whole files. An unbounded attribute would make
 * a single span exceed the collector's payload limit and take the entire batch
 * down with it — so truncation here protects delivery of the *other* spans, and
 * is applied even at `full`.
 */
const MAX_CONTENT_CHARS = 24_000;

function truncate(value: string): string {
  return value.length <= MAX_CONTENT_CHARS
    ? value
    : `${value.slice(0, MAX_CONTENT_CHARS)}…[truncated ${value.length - MAX_CONTENT_CHARS} chars]`;
}

/** Parse a record timestamp to epoch millis, falling back to a supplied default. */
function timeOf(record: NormalizedRecord, fallback: number): number {
  if (!("timestamp" in record) || typeof record.timestamp !== "string") {
    return fallback;
  }
  const parsed = Date.parse(record.timestamp);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Resource-level attributes identifying this capture path. */
export function resourceAttributes(hostInfo: HostInfo): Attributes {
  const attrs: Attributes = {
    "service.name": SERVICE_NAME,
    "service.version": VERSION,
    "introspection.plugin.host": hostInfo.host,
  };
  if (hostInfo.hostVersion) {
    attrs["introspection.plugin.host_version"] = hostInfo.hostVersion;
  }
  if (hostInfo.entrypoint) {
    attrs["introspection.plugin.host_entrypoint"] = hostInfo.entrypoint;
  }
  return attrs;
}

function agentNameFor(host: CaptureHost): string {
  return host === "claude-code" ? "claude-code" : "codex";
}

/**
 * Convert one turn's records into spans on `tracer`.
 *
 * The records are expected to be a *chunk* — the output of normalizing only the
 * bytes appended since the last checkpoint — so a leading `meta` record may be
 * present and tool results may reference calls made in an earlier chunk. Both
 * are handled: an unmatched tool result is dropped rather than guessed at, and
 * a tool call left open at the end of the chunk is closed at the turn boundary
 * so no span leaks.
 */
export function emitTurnSpans(
  tracer: Tracer,
  records: NormalizedTranscript,
  ctx: TurnContext,
): TurnSpans {
  const conversational = records.filter((r) => r.role !== "meta");
  if (conversational.length === 0) return { spanCount: 0 };

  const meta = records.find((r) => r.role === "meta");
  const now = Date.now();
  const startTime = timeOf(conversational[0]!, now);
  const endTime = timeOf(conversational[conversational.length - 1]!, now);
  const provider = providerForHost(ctx.hostInfo.host);
  const captureContent = ctx.content === "full";

  const model = meta?.role === "meta" ? meta.model : undefined;
  let spanCount = 0;

  const turnAttrs: Attributes = {
    "gen_ai.provider.name": provider,
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.name": agentNameFor(ctx.hostInfo.host),
    "gen_ai.conversation.id": ctx.sessionId,
    "introspection.plugin.turn": ctx.turn,
  };
  if (meta?.role === "meta" && meta.git_branch) {
    turnAttrs["introspection.plugin.git_branch"] = meta.git_branch;
  }

  const turnSpan = tracer.startSpan(`invoke_agent ${ctx.hostInfo.host}`, {
    kind: SpanKind.CLIENT,
    startTime,
    attributes: turnAttrs,
  });
  spanCount += 1;

  // Parent every child on the turn span explicitly. This process registers no
  // context manager — a hook is a single short-lived run with no concurrency to
  // track — so `context.active()` is the root context and implicit parenting
  // would silently produce a flat list of unrelated traces.
  const turnContext = otelTrace.setSpan(otelContext.active(), turnSpan);

  // Tool calls and their results arrive as separate records, linked by id, and
  // a result can land in a later chunk than its call. Holding the open spans in
  // a map is what lets a tool span span that gap.
  const openTools = new Map<string, Span>();
  const inputMessages: string[] = [];
  const outputMessages: string[] = [];

  for (const record of conversational) {
    const at = timeOf(record, now);

    switch (record.role) {
      case "user": {
        if (captureContent) inputMessages.push(record.content);
        break;
      }

      case "reasoning": {
        // Reasoning is model-authored content, so it follows the content gate
        // exactly as completions do rather than being treated as metadata.
        if (captureContent) outputMessages.push(record.content);
        break;
      }

      case "assistant": {
        if (record.content === null) {
          for (const call of record.tool_calls) {
            const toolAttrs: Attributes = {
              "gen_ai.operation.name": "execute_tool",
              "gen_ai.tool.name": call.name,
              "gen_ai.tool.type": "function",
              "gen_ai.tool.call.id": call.id,
              "gen_ai.conversation.id": ctx.sessionId,
            };
            if (captureContent) {
              toolAttrs["gen_ai.tool.call.arguments"] = truncate(call.args);
            }
            const span = tracer.startSpan(
              `execute_tool ${call.name}`,
              { kind: SpanKind.INTERNAL, startTime: at, attributes: toolAttrs },
              turnContext,
            );
            openTools.set(call.id, span);
            spanCount += 1;
          }
        } else {
          if (captureContent) outputMessages.push(record.content);
          const chatSpan = tracer.startSpan(
            `chat ${model ?? provider}`,
            {
              kind: SpanKind.CLIENT,
              startTime: at,
              attributes: {
                "gen_ai.provider.name": provider,
                "gen_ai.operation.name": "chat",
                "gen_ai.conversation.id": ctx.sessionId,
                ...(model ? { "gen_ai.request.model": model } : {}),
                ...(captureContent
                  ? { "gen_ai.output.messages": truncate(record.content) }
                  : {}),
              },
            },
            turnContext,
          );
          chatSpan.setStatus({ code: SpanStatusCode.OK });
          chatSpan.end(at);
          spanCount += 1;
        }
        break;
      }

      case "tool": {
        const span = openTools.get(record.tool_call_id);
        // No matching call means the call lived in a chunk we already exported.
        // Dropping it is correct: fabricating a parent span would invent a
        // duration and a position in the turn that never happened.
        if (!span) break;
        if (captureContent) {
          span.setAttribute(
            "gen_ai.tool.call.result",
            truncate(record.content),
          );
        }
        if (record.ok === false) {
          span.setStatus({ code: SpanStatusCode.ERROR });
        } else if (record.ok === true) {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        span.end(at);
        openTools.delete(record.tool_call_id);
        break;
      }
    }
  }

  // A tool still open at the turn boundary was cut short — the session ended, or
  // the call is genuinely still running. Close it at the turn's end so the span
  // is delivered rather than abandoned in the batch processor.
  for (const [, span] of openTools) {
    span.setAttribute("introspection.plugin.tool_unterminated", true);
    span.end(endTime);
  }

  if (captureContent) {
    if (inputMessages.length > 0) {
      turnSpan.setAttribute(
        "gen_ai.input.messages",
        truncate(inputMessages.join("\n\n")),
      );
    }
    if (outputMessages.length > 0) {
      turnSpan.setAttribute(
        "gen_ai.output.messages",
        truncate(outputMessages.join("\n\n")),
      );
    }
  }
  if (model) turnSpan.setAttribute("gen_ai.request.model", model);
  turnSpan.setStatus({ code: SpanStatusCode.OK });
  turnSpan.end(endTime);

  return { spanCount, model };
}
