/**
 * What Flight Sector's services saw, in order, so the walkthrough can light up
 * each step as the demo runs. In-memory and per process.
 */
import "server-only";

export type FlowEventType =
  | "booking.searched"
  | "booking.challenged"
  | "booking.reserved"
  | "acme.mission_approved"
  | "acme.mission_completed"
  | "acme.approval_requested"
  | "acme.decided"
  | "acme.auth_token_issued";

export interface FlowEvent {
  seq: number;
  at: string;
  type: FlowEventType;
  summary: string;
  data: Record<string, unknown>;
}

const MAX_EVENTS = 200;
const store = globalThis as unknown as {
  __flightSectorEvents?: { seq: number; events: FlowEvent[] };
};
const log = (store.__flightSectorEvents ??= { seq: 0, events: [] });

export function record(
  type: FlowEventType,
  summary: string,
  data: Record<string, unknown> = {},
): void {
  log.seq += 1;
  log.events.push({
    seq: log.seq,
    at: new Date().toISOString(),
    type,
    summary,
    data,
  });
  if (log.events.length > MAX_EVENTS)
    log.events.splice(0, log.events.length - MAX_EVENTS);
}

export function since(seq: number): FlowEvent[] {
  return log.events.filter((event) => event.seq > seq);
}
