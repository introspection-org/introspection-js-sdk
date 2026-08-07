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
 * `invoke_agent` / `create_agent` wrapper span (stored) or the `agent`
 * management tool's start call (live). This is the "shallow subagent
 * status" a main chat renders as a chip; `agentId` is the key a drill-in
 * read passes as the items `agent` filter to open the subagent's own
 * transcript.
 *
 * Correlation is by invocation, not agent role: two invocations of the
 * same `researcher` are two entries. Cross-transport precedence is
 * `invocationId` (the durable child agent-run id — the wrapper span's
 * `introspection.agent.invocation_id`, the `agent` tool result's
 * `agent_run_id`), then `sourceToolCallId`, then entry id; `agentId` is a
 * legacy fallback for emitters that stamp neither.
 */
export interface TranscriptDelegationEntry {
  kind: "delegation";
  /** Stable entry ID (`span:{span_id}:delegation` / `delegation-tool:{callId}`). */
  id: string;
  /** Durable child agent-run id — the primary correlation key. */
  invocationId?: string;
  /** The `agent` tool call that launched the delegation (live transport). */
  sourceToolCallId?: string;
  /** `gen_ai.agent.id` of the delegated agent, when stamped. */
  agentId?: string;
  /** `gen_ai.agent.name` of the delegated agent, when stamped. */
  agentName?: string;
  /** Human-readable delegation label, when the start call carried one. */
  label?: string;
  status: TranscriptStatus;
  /** Wrapper span duration in nanoseconds, when the span has ended. */
  durationNs?: number;
  /** Span the entry was folded from. */
  spanId?: string;
}

/**
 * An interruption awaiting outside input. Reserved: no fold emits it yet —
 * `awaiting_user` reaches clients as a run status today; the entry exists so
 * the projection can carry the prompt once run metadata exposes it.
 */
export interface TranscriptInterruptEntry {
  kind: "interrupt";
  /** Stable entry ID. */
  id: string;
  /** Why the conversation is paused (e.g. `awaiting_user`). */
  reason: string;
}

/** One entry of the folded transcript, in render order. */
export type TranscriptEntry =
  | TranscriptMessageEntry
  | TranscriptToolEntry
  | TranscriptDelegationEntry
  | TranscriptInterruptEntry;
