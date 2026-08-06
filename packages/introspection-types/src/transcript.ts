/**
 * Transcript view-model types — the one shape both transcript folds emit.
 *
 * A chat product renders the same conversation from two transports: the live
 * AG-UI event stream while a run executes, and the persisted GenAI spans
 * after a refresh. Historically every consumer wrote its own spans→messages
 * logic and its own live↔stored reconciliation heuristics, and the two
 * projections drifted (`docs/design/conversation-transcript-scope.md` in the
 * cloud repo records the measured cost). These types are the shared target:
 * `foldSpans` and `foldAgui` in `@introspection-sdk/http` both produce
 * `TranscriptEntry[]`, so parity is a property of one module instead of a
 * per-app effort.
 *
 * Entries are a client-side view model, not a wire shape — fields are
 * camelCase like the AG-UI vocabulary, not snake_case like the span
 * envelope.
 */

/** Lifecycle of a tool call or delegation within a transcript. */
export type TranscriptStatus = "running" | "complete" | "error";

/**
 * A rendered chat message.
 *
 * `id` is stable across transports where the wire allows it: a stored
 * assistant message prefers `gen_ai.response.id`, a stored user message
 * prefers `introspection.conversation.client_message_id`, and otherwise the
 * id is synthesized from span identity (`span:{span_id}:...`) so re-folding
 * the same data can never mint a second id for the same entry.
 */
export interface TranscriptMessageEntry {
  kind: "message";
  /** Stable entry ID (see the id rules above). */
  id: string;
  role: "user" | "assistant";
  /** Concatenated text content of the message. */
  text: string;
  /** Accumulated thinking / reasoning summary, when present. */
  thinking?: string;
  /** `gen_ai.response.id` correlation key, when known. */
  responseId?: string;
  /** `introspection.conversation.client_message_id`, when known. */
  clientMessageId?: string;
  /** Span the entry was folded from (stored transport only). */
  spanId?: string;
}

/**
 * One tool call and (when it arrived) its result, folded from the two
 * places a call can appear on the wire — the `execute_tool` span's
 * `gen_ai.tool.*` attributes and the assistant output's `tool_call` part —
 * or from the AG-UI `TOOL_CALL_*` lifecycle. `callId` is the cross-transport
 * correlation key.
 */
export interface TranscriptToolEntry {
  kind: "tool";
  /** Stable entry ID (`tool:{callId}`). */
  id: string;
  /** Tool call correlation ID. */
  callId: string;
  /** Tool / function name. */
  name: string;
  /** Raw JSON-encoded arguments, as far as they have streamed. */
  arguments?: string;
  /** The tool's response value, when it has arrived. */
  result?: unknown;
  status: TranscriptStatus;
  /** Span the entry was folded from (stored transport only). */
  spanId?: string;
}

/**
 * A delegation boundary — one subagent invocation, carried by the
 * `invoke_agent` / `create_agent` wrapper span. This is the "shallow
 * subagent status" a main chat renders as a chip; `agentId` is the key a
 * drill-in read passes as the items `agent_id` filter to open the
 * subagent's own transcript.
 */
export interface TranscriptDelegationEntry {
  kind: "delegation";
  /** Stable entry ID (`span:{span_id}:delegation`). */
  id: string;
  /** `gen_ai.agent.id` of the delegated agent, when stamped. */
  agentId?: string;
  /** `gen_ai.agent.name` of the delegated agent, when stamped. */
  agentName?: string;
  /** One durable child invocation, used to correlate live and stored forms. */
  invocationId?: string;
  /** AG-UI call that launched the child, when this entry is still live. */
  sourceToolCallId?: string;
  /** Optional user-facing label distinguishing concurrent invocations. */
  label?: string;
  status: TranscriptStatus;
  /** Wrapper span duration in nanoseconds, when the span has ended. */
  durationNs?: number;
  /** Span the entry was folded from. */
  spanId?: string;
}

/** One entry of the folded transcript, in render order. */
export type TranscriptEntry =
  TranscriptMessageEntry | TranscriptToolEntry | TranscriptDelegationEntry;
