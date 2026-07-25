/**
 * One-call session attach: wrap a live Pi agent session so it emits the full
 * GenAI semconv span set — `chat {model}` spans via the wrapped stream
 * function, `execute_tool` spans via the agent subscription, and (by
 * default) one `invoke_agent` span per run that the others nest under.
 *
 * This is the seam every host shares. Hosts that create their own turn/run
 * spans pass `runSpans: false` plus `getParentContext` (and optionally
 * `abortTerminationReason` / `extraAttributes`) so chat and tool spans nest
 * under the host's spans instead of a package-created run span.
 *
 * Compaction summaries are sourced structurally from the session tree
 * (`sessionManager.getEntries()` filtered to `type === "compaction"`), so
 * detection does not depend on the prose wrapper pi renders around them —
 * callers no longer wire `getCompactionSummaries` by hand.
 */
import {
  type Attributes,
  type Context as OtelContext,
  type Meter,
  type Tracer,
} from "@opentelemetry/api";
import type { Agent, StreamFn } from "@earendil-works/pi-agent-core";
import { type AbortTerminationReason } from "@introspection-sdk/types";
import { type AgentMeta } from "./attributes.js";
import { instrumentAgent } from "./instrument-agent.js";
import { instrumentStream } from "./instrument-stream.js";

/**
 * The structural slice of a pi coding-agent `AgentSession` this attach
 * needs: the agent (stream function + event subscription) and the session
 * tree (compaction summaries). Typed structurally so the package keeps no
 * dependency on the session host package.
 */
export interface InstrumentableAgentSession {
  agent: Agent;
  sessionManager: { getEntries(): readonly unknown[] };
}

export interface InstrumentSessionOptions {
  /** Tracer the gen_ai spans are started on. */
  tracer: Tracer;
  /** Span identity for this session. */
  meta: AgentMeta;
  /** Optional meter for the GenAI client metrics. */
  meter?: Meter;
  /**
   * Emit one `invoke_agent` span per run and nest chat/tool spans under it.
   * Hosts that create their own turn/run spans set false and supply
   * `getParentContext` instead. Default: true.
   */
  runSpans?: boolean;
  /**
   * Parent context for chat and tool spans. Default: the active run span
   * (when `runSpans` is on), else the active OTel context.
   */
  getParentContext?: () => OtelContext | null | undefined;
  /**
   * Classify a chat stream that ended via the caller's AbortSignal:
   * `"cancelled"` / `"awaiting_user"` end the span cleanly, `null` keeps
   * the abort classified as an error. Default: aborts are `"cancelled"`.
   */
  abortTerminationReason?: () => AbortTerminationReason | null;
  /** Host attributes (tenant labels, correlation ids) added to every span. */
  extraAttributes?: () => Attributes;
}

export interface SessionInstrumentation {
  /** Restore the original stream function and finalize any open spans. */
  detach: () => void;
}

/**
 * The agent's stream function property was renamed `streamFn` →
 * `streamFunction` across pi releases this package supports as peers; the
 * attach resolves whichever the installed generation defines.
 */
type StreamFnKey = "streamFunction" | "streamFn";

function streamFnKey(agent: Agent): StreamFnKey {
  return "streamFunction" in agent ? "streamFunction" : "streamFn";
}

interface SessionEntryLike {
  type?: string;
  summary?: unknown;
}

function compactionSummaries(
  session: InstrumentableAgentSession,
): readonly string[] {
  return (session.sessionManager.getEntries() as readonly SessionEntryLike[])
    .filter(
      (entry): entry is { summary: string } =>
        entry.type === "compaction" && typeof entry.summary === "string",
    )
    .map((entry) => entry.summary);
}

/**
 * Attach the GenAI instrumentation to a live session. Returns a handle
 * whose `detach()` restores the stream function and finalizes open spans.
 */
export function instrumentSession(
  session: InstrumentableAgentSession,
  opts: InstrumentSessionOptions,
): SessionInstrumentation {
  const agent = session.agent as unknown as Record<StreamFnKey, StreamFn>;
  const key = streamFnKey(session.agent);
  const original = agent[key];
  const extraAttributes = opts.extraAttributes;

  const agentInstrumentation = instrumentAgent(session.agent, {
    tracer: opts.tracer,
    meta: opts.meta,
    ...(opts.meter ? { meter: opts.meter } : {}),
    runSpans: opts.runSpans ?? true,
    ...(opts.getParentContext
      ? { getParentContext: opts.getParentContext }
      : {}),
    ...(extraAttributes ? { extraAttributes: () => extraAttributes() } : {}),
  });

  agent[key] = instrumentStream(original, {
    tracer: opts.tracer,
    meta: opts.meta,
    ...(opts.meter ? { meter: opts.meter } : {}),
    getParentContext:
      opts.getParentContext ?? (() => agentInstrumentation.getRunContext()),
    ...(opts.abortTerminationReason
      ? { abortTerminationReason: opts.abortTerminationReason }
      : {}),
    ...(extraAttributes ? { extraAttributes: () => extraAttributes() } : {}),
    getCompactionSummaries: () => compactionSummaries(session),
  });

  return {
    detach: () => {
      agent[key] = original;
      agentInstrumentation.stop();
    },
  };
}
