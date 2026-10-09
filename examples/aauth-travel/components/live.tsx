"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

export interface FlowEvent {
  seq: number;
  at: string;
  type: string;
  summary: string;
  data: Record<string, unknown>;
}

export interface StepLights {
  id: string;
  lights?: { type: string; where?: Record<string, string | boolean> };
}

const POLL_MS = 1500;

function matches(
  event: FlowEvent,
  lights: NonNullable<StepLights["lights"]>,
): boolean {
  if (event.type !== lights.type) return false;
  return Object.entries(lights.where ?? {}).every(
    ([key, expected]) => event.data[key] === expected,
  );
}

const LiveContext = createContext<{ events: FlowEvent[]; lit: Set<string> }>({
  events: [],
  lit: new Set(),
});

export function LiveProvider({
  steps,
  children,
}: {
  steps: StepLights[];
  children: React.ReactNode;
}) {
  const [events, setEvents] = useState<FlowEvent[]>([]);

  useEffect(() => {
    let after = 0;
    let stopped = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/events?after=${after}`, {
          cache: "no-store",
        });
        const { events: fresh } = (await res.json()) as { events: FlowEvent[] };
        if (!stopped && fresh.length) {
          after = fresh[fresh.length - 1].seq;
          setEvents((prev) => [...prev, ...fresh]);
        }
      } catch {
        // the next poll retries
      }
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  const lit = useMemo(
    () =>
      new Set(
        steps
          .filter(
            (step) =>
              step.lights &&
              events.some((event) => matches(event, step.lights!)),
          )
          .map((step) => step.id),
      ),
    [events, steps],
  );

  return (
    <LiveContext.Provider value={{ events, lit }}>
      {children}
    </LiveContext.Provider>
  );
}

export function StepDot({ id, live }: { id: string; live: boolean }) {
  const { lit } = useContext(LiveContext);
  if (!live)
    return (
      <span className="dot dot-platform" title="Happens inside the platform" />
    );
  return (
    <span
      className={lit.has(id) ? "dot dot-lit" : "dot"}
      title={lit.has(id) ? "Seen in this run" : "Waiting"}
    />
  );
}

export function EventFeed() {
  const { events } = useContext(LiveContext);
  if (!events.length) {
    return (
      <p className="feed-empty">
        Waiting for the agent. Message it in Slack and Flight Sector&rsquo;s
        side of each step appears here.
      </p>
    );
  }
  return (
    <ol className="feed">
      {events.slice(-12).map((event) => (
        <li key={event.seq}>
          <time>{new Date(event.at).toLocaleTimeString()}</time>
          <code>{event.type}</code>
          <span>{event.summary}</span>
        </li>
      ))}
    </ol>
  );
}
