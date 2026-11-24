"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  EvalFinished,
  EvalRunFinished,
  EvalStarted,
} from "@/lib/platform-evals";

interface Config {
  configured: boolean;
  missing: string | null;
  how_to: string;
  target: { runtime: string; commit: string } | null;
  target_error: string | null;
  active: string | null;
}

interface FeedEvent {
  seq: number;
  type: string;
  summary: string;
  data: Record<string, unknown>;
}

const MAX_SCENES = 400;

interface Trial {
  started: EvalStarted;
  finished?: EvalFinished;
}

interface RunView {
  run: string;
  trials: Map<string, Trial>;
  finished?: EvalRunFinished;
}

const NIGHT_ORDER = ["night1-memory", "night2-hosted", "night2-control"];

function fold(
  view: RunView | undefined,
  event: FeedEvent,
): RunView | undefined {
  const run = event.data.run as string;
  const current: RunView =
    view && view.run === run
      ? { ...view, trials: new Map(view.trials) }
      : { run, trials: new Map<string, Trial>() };
  if (event.type === "eval.started") {
    const started = event.data as unknown as EvalStarted;
    current.trials.set(`${started.venue}/${started.night}`, { started });
  } else if (event.type === "eval.finished") {
    const finished = event.data as unknown as EvalFinished;
    const key = `${finished.venue}/${finished.night}`;
    current.trials.set(key, { started: finished, finished });
  } else if (event.type === "eval.run_finished") {
    current.finished = event.data as unknown as EvalRunFinished;
  }
  return current;
}

export function PlatformEvals() {
  const [config, setConfig] = useState<Config>();
  const [venues, setVenues] = useState(3);
  const [view, setView] = useState<RunView>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<string>();
  const [scenes, setScenes] = useState<FeedEvent[]>([]);
  const [sceneVenue, setSceneVenue] = useState<string>();
  const [openScene, setOpenScene] = useState<number>();
  const cursor = useRef(0);
  const log = useRef<HTMLOListElement>(null);

  const loadConfig = useCallback(async () => {
    const response = await fetch("/api/evals");
    const body = await response.json();
    if (!response.ok) setError(body.error);
    else setConfig(body);
  }, []);

  const poll = useCallback(async () => {
    const more = (await fetch(`/api/events?after=${cursor.current}`).then((r) =>
      r.json(),
    )) as { events: FeedEvent[] };
    if (!more.events.length) return;
    cursor.current = Math.max(
      cursor.current,
      more.events[more.events.length - 1].seq,
    );
    setView((current) =>
      more.events
        .filter((event) => event.type.startsWith("eval."))
        .reduce(fold, current),
    );
    // Two polls can overlap (React runs effects twice in development), so an
    // event already shown is skipped rather than shown again.
    setScenes((current) => {
      const seen = new Set(current.map((event) => event.seq));
      const fresh = more.events.filter(
        (event) =>
          !event.type.startsWith("eval.") &&
          typeof event.data.venue === "string" &&
          !seen.has(event.seq),
      );
      return fresh.length ? [...current, ...fresh].slice(-MAX_SCENES) : current;
    });
    const finished = new Set(
      more.events
        .filter((event) => event.type === "eval.run_finished")
        .map((event) => event.data.run as string),
    );
    if (finished.size)
      setConfig(
        (current) =>
          current &&
          (current.active && finished.has(current.active)
            ? { ...current, active: null }
            : current),
      );
  }, []);

  useEffect(() => {
    loadConfig();
    poll();
  }, [loadConfig, poll]);

  const running = Boolean(view && !view.finished) || Boolean(config?.active);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(poll, 2000);
    return () => clearInterval(timer);
  }, [running, poll]);

  const start = async () => {
    setError(undefined);
    const response = await fetch("/api/evals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ venues }),
    });
    const body = await response.json();
    if (!response.ok) setError(body.error);
    else setConfig((current) => current && { ...current, active: body.run });
    await poll();
  };

  const trialVenues = [
    ...new Set(
      (view ? [...view.trials.values()] : []).map(
        ({ started }) => started.venue,
      ),
    ),
  ].sort();
  const shownVenue =
    sceneVenue && trialVenues.includes(sceneVenue)
      ? sceneVenue
      : trialVenues[0];
  const shown = scenes.filter(
    (event) => event.data.run === view?.run && event.data.venue === shownVenue,
  );

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [shown.length, shownVenue]);

  const trials = view
    ? [...view.trials.values()].sort(
        (a, b) =>
          a.started.venue.localeCompare(b.started.venue) ||
          NIGHT_ORDER.indexOf(a.started.night) -
            NIGHT_ORDER.indexOf(b.started.night),
      )
    : [];

  return (
    <div className="columns">
      <section className="platform">
        <div className="host-head">
          <div>
            <h2>
              On the platform <span className="tag">real evals</span>
            </h2>
            <p>
              Runs the memory evals as cloud trials of the deployed host: night
              1 then night 2 per venue, each venue its own identity, all venues
              at once, and one control with no memory.
            </p>
          </div>
        </div>

        {config && !config.configured && (
          <div className="notice">
            <p>
              No agent key: {config.missing}. Create a key that expires today,
              then restart <code>pnpm dev</code>:
            </p>
            <pre className="notes">{config.how_to}</pre>
          </div>
        )}

        <div className="platform-form">
          <label>
            Venues{" "}
            <input
              type="number"
              min={1}
              max={8}
              value={venues}
              onChange={(event) => setVenues(Number(event.target.value))}
            />
          </label>
          <span className="fine">
            Runtime <code>{config?.target?.runtime ?? "…"}</code> at{" "}
            <code>{config?.target?.commit.slice(0, 12) ?? "…"}</code>
          </span>
          <button
            disabled={!config?.configured || !config?.target || running}
            onClick={start}
          >
            {running ? "Running…" : "Run evals on the platform"}
          </button>
        </div>
        {config?.target_error && <p className="bad">{config.target_error}</p>}
        {error && <p className="bad">{error}</p>}

        {view && (
          <>
            <p className="fine">
              Run <code>{view.run}</code>
              {view.finished
                ? `: ${view.finished.trials} trials in ${view.finished.seconds}s wall-clock`
                : ": running"}
            </p>
            <table>
              <thead>
                <tr>
                  <th>Venue</th>
                  <th>Night</th>
                  <th>Reward</th>
                  <th>Checks</th>
                  <th>Scored from</th>
                  <th>Seconds</th>
                </tr>
              </thead>
              <tbody>
                {trials.map(({ started, finished }) => {
                  const key = `${started.venue}/${started.night}`;
                  return (
                    <tr
                      key={key}
                      onClick={() => setOpen(open === key ? undefined : key)}
                    >
                      <td>{started.venue}</td>
                      <td>{started.night}</td>
                      <td
                        className={finished?.reward === 0 ? "bad" : undefined}
                      >
                        {finished ? (finished.reward ?? "none") : "running"}
                      </td>
                      <td>
                        {finished &&
                          Object.entries(finished.checks).map(
                            ([name, value]) => (
                              <span
                                key={name}
                                className={value ? "check" : "check bad"}
                              >
                                {value ? "✓" : "✗"} {name}{" "}
                              </span>
                            ),
                          )}
                        {finished?.error && (
                          <span className="bad" title={finished.error}>
                            {finished.error.split("\n")[0]}
                          </span>
                        )}
                        {finished?.notes &&
                          (open === key ? (
                            <pre className="notes">{finished.notes}</pre>
                          ) : (
                            <span className="fine preview">
                              {finished.notes.split("\n").find(Boolean)}
                            </span>
                          ))}
                      </td>
                      <td>{finished?.trajectory_source ?? ""}</td>
                      <td>{finished?.seconds ?? ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="fine">Click a row for the notes it left.</p>
          </>
        )}
      </section>

      <aside className="scenes">
        <div className="scenes-head">
          <h2>Behind the scenes</h2>
        </div>
        <p className="fine">
          What the agent does in each trial, streamed from the platform as it
          runs: every bank call, and every read and write of the venue&apos;s
          notes.
        </p>
        <nav className="venues" aria-label="Venue">
          {trialVenues.map((item) => (
            <button
              key={item}
              className={item === shownVenue ? "current" : undefined}
              onClick={() => setSceneVenue(item)}
            >
              {item}
            </button>
          ))}
        </nav>
        <ol ref={log}>
          {shown.length === 0 && (
            <li className="empty">
              {view
                ? "Nothing from this venue yet."
                : "Run the evals to see what the agent does."}
            </li>
          )}
          {shown.map((event) => (
            <li key={event.seq}>
              <button
                className="event"
                onClick={() =>
                  setOpenScene(openScene === event.seq ? undefined : event.seq)
                }
              >
                <span className={`kind kind-${event.type.split(".")[0]}`}>
                  {event.type}
                </span>
                <span className="who">{String(event.data.night)}</span>
                <span>{event.summary}</span>
              </button>
              {openScene === event.seq && (
                <pre>
                  {typeof event.data.file === "string"
                    ? event.data.file
                    : JSON.stringify(
                        event.data.arguments ?? event.data.edit ?? event.data,
                        null,
                        2,
                      )}
                </pre>
              )}
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}
