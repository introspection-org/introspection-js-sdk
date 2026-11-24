/**
 * What happened behind the quiz, in order, so the page can show each bank
 * lookup and each memory read and write as it runs. In-memory and per process.
 */
type FlowEventType =
  | "bank.served"
  | "bank.relaxed"
  | "bank.marked"
  | "memory.read"
  | "memory.written"
  | "host.planned"
  | "round.finished"
  | "eval.started"
  | "eval.finished"
  | "eval.run_finished";

export interface FlowEvent {
  seq: number;
  at: string;
  owner: string;
  type: FlowEventType;
  summary: string;
  data: Record<string, unknown>;
}

export type Recorder = (
  owner: string,
  type: FlowEventType,
  summary: string,
  data?: Record<string, unknown>,
) => void;

const MAX_EVENTS = 400;
const store = globalThis as unknown as {
  __triviaEvents?: { seq: number; events: FlowEvent[] };
};
// Starts at the boot time, so a restarted server never reuses a number a page
// already holds: the page asks for events after the last one it has.
const log = (store.__triviaEvents ??= { seq: Date.now(), events: [] });

export const record: Recorder = (owner, type, summary, data = {}) => {
  log.seq += 1;
  log.events.push({
    seq: log.seq,
    at: new Date().toISOString(),
    owner,
    type,
    summary,
    data,
  });
  if (log.events.length > MAX_EVENTS)
    log.events.splice(0, log.events.length - MAX_EVENTS);
};

export function since(seq: number): FlowEvent[] {
  return log.events.filter((event) => event.seq > seq);
}

export function clearEvents(): void {
  log.events.length = 0;
}
