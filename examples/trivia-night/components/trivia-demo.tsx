"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Night {
  week: number;
  rate: number;
  pitch_miss: number;
  rounds: number;
  rounds_on_target: number;
  liked_rounds: number;
  unfair_questions: number;
  repeats: number;
  close_calls: number;
  blanks: number;
}

interface HostState {
  host: "forgetful" | "attentive";
  owner: string;
  week: number;
  asked: number;
  notes: string | null;
  nights: Night[];
}

interface VenueState {
  id: string;
  name: string;
  region: string;
  likes: string[];
  held_out: boolean;
  hosts: HostState[];
}

interface DemoState {
  bank_size: number;
  venues: VenueState[];
}

interface FlowEvent {
  seq: number;
  owner: string;
  type: string;
  summary: string;
  data: Record<string, unknown>;
}

const HOST_BLURB = {
  forgetful: "Plans every night the same way. Keeps no notes.",
  attentive:
    "Reads its notes on this venue before planning, and updates them after.",
};

const pct = (value: number) => `${Math.round(value * 100)}%`;

export function TriviaDemo() {
  const [state, setState] = useState<DemoState>();
  const [venueId, setVenueId] = useState("the-anchor");
  const [events, setEvents] = useState<FlowEvent[]>([]);
  const [open, setOpen] = useState<number>();
  const last = useRef(0);
  const log = useRef<HTMLOListElement>(null);

  const refresh = useCallback(async () => {
    const [next, more] = await Promise.all([
      fetch("/api/demo/state").then((r) => r.json()),
      fetch(`/api/events?after=${last.current}`).then((r) => r.json()),
    ]);
    setState(next);
    if (more.events.length) {
      last.current = more.events[more.events.length - 1].seq;
      setEvents((current) => [...current, ...more.events].slice(-400));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [events, venueId]);

  const act = async (body: Record<string, string>) => {
    await fetch("/api/demo/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (body.action === "restart") {
      last.current = 0;
      setEvents([]);
    }
    await refresh();
  };

  const venue = state?.venues.find((item) => item.id === venueId);
  const shown = events.filter((event) => event.owner.endsWith(`:${venueId}`));

  return (
    <main className="page">
      <header>
        <h1>Trivia Night</h1>
        <p>
          One question bank, two hosts. The bank never repeats a question at a
          venue. Only a host that remembers the venue can pitch the night to its
          crowd.
        </p>
      </header>

      <nav className="venues" aria-label="Venue">
        {state?.venues.map((item) => (
          <button
            key={item.id}
            className={item.id === venueId ? "current" : undefined}
            onClick={() => setVenueId(item.id)}
          >
            {item.name}
            {item.held_out && <span className="tag">held out</span>}
          </button>
        ))}
        <button className="quiet" onClick={() => act({ action: "restart" })}>
          Start over
        </button>
      </nav>

      {venue && (
        <p className="about">
          Region <strong>{venue.region}</strong>. The crowd likes{" "}
          <strong>{venue.likes.join(" and ")}</strong>. The bank holds{" "}
          {state?.bank_size} questions.
        </p>
      )}

      <div className="columns">
        <section className="hosts">
          {venue?.hosts.map((host) => (
            <article key={host.host} className="host">
              <div className="host-head">
                <div>
                  <h2>The {host.host} host</h2>
                  <p>{HOST_BLURB[host.host]}</p>
                </div>
                <button
                  onClick={() =>
                    act({ action: "play", venue: venue.id, host: host.host })
                  }
                >
                  Play week {host.week + 1}
                </button>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Week</th>
                    <th>Right</th>
                    <th>Pitch miss</th>
                    <th>Asked-for rounds</th>
                    <th>Unfair</th>
                    <th>Blanks</th>
                    <th>Repeats</th>
                  </tr>
                </thead>
                <tbody>
                  {host.nights.length === 0 && (
                    <tr>
                      <td colSpan={7} className="empty">
                        No nights played yet.
                      </td>
                    </tr>
                  )}
                  {host.nights.map((night) => (
                    <tr key={night.week}>
                      <td>{night.week}</td>
                      <td>{pct(night.rate)}</td>
                      <td>{Math.round(night.pitch_miss * 100)} pts</td>
                      <td>
                        {night.liked_rounds}/{night.rounds}
                      </td>
                      <td
                        className={night.unfair_questions ? "bad" : undefined}
                      >
                        {night.unfair_questions}
                      </td>
                      <td>{night.blanks}</td>
                      <td className={night.repeats ? "bad" : undefined}>
                        {night.repeats}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3>What this host remembers about the venue</h3>
              <pre className="notes">
                {host.notes ?? "Nothing. It starts every night from scratch."}
              </pre>
              <p className="fine">
                The bank has asked this venue {host.asked} of {state?.bank_size}{" "}
                questions.
              </p>
            </article>
          ))}
        </section>

        <aside className="scenes">
          <div className="scenes-head">
            <h2>Behind the scenes</h2>
          </div>
          <ol ref={log}>
            {shown.length === 0 && (
              <li className="empty">Play a night to see what happens.</li>
            )}
            {shown.map((event) => (
              <li key={event.seq}>
                <button
                  className="event"
                  onClick={() =>
                    setOpen(open === event.seq ? undefined : event.seq)
                  }
                >
                  <span className={`kind kind-${event.type.split(".")[0]}`}>
                    {event.type}
                  </span>
                  <span className="who">{event.owner.split(":")[0]}</span>
                  <span>{event.summary}</span>
                </button>
                {open === event.seq && (
                  <pre>
                    {typeof event.data.file === "string"
                      ? event.data.file
                      : JSON.stringify(event.data, null, 2)}
                  </pre>
                )}
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </main>
  );
}
