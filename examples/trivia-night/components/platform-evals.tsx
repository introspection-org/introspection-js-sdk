"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import type {
  EvalFinished,
  EvalRunFinished,
  EvalStarted,
} from "@/lib/platform-evals";
import {
  factChips,
  kindLabel,
  notesPreview,
  plainText,
  targetLabel,
  toolLine,
} from "@/lib/display";
import {
  compare,
  MEASURES,
  signed,
  type MeasureKey,
  type Measures,
  type Tally,
} from "@/lib/memory-measures";

interface Config {
  configured: boolean;
  max_venues?: number;
  missing: string | null;
  how_to: string;
  target: { runtime: string; commit: string; slug?: string } | null;
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

const NIGHT_NAMES: Record<string, string> = {
  "night1-memory": "Night 1",
  "night2-hosted": "Night 2 with memory",
  "night2-fresh": "Night 2 without",
};

/** The scenes' night filter: every night, or one of a venue's three. */
const NIGHT_FILTERS: [string | undefined, string][] = [
  [undefined, "All nights"],
  ["night1-memory", "Night 1"],
  ["night2-hosted", "Night 2 with memory"],
  ["night2-fresh", "Night 2 without"],
];

const CELL_MEASURES: MeasureKey[] = [
  "notes_written",
  "recalled",
  "right_region",
  "liked_genres",
  "difficulty_from_notes",
];

/** A trial's measures as compact marks: `✓ region`, `genres 67%`. */
function MeasureMarks({ measures }: { measures: Measures }) {
  const shown = CELL_MEASURES.filter(
    (key) => typeof measures[key] === "number",
  );
  if (!shown.length) return null;
  return (
    <span className="marks">
      {shown.map((key) => {
        const value = measures[key]!;
        const { short, why } = MEASURES[key];
        if (key === "liked_genres")
          return (
            <span
              key={key}
              className={value >= 0.5 ? "mark pass" : "mark bad"}
              title={why}
            >
              {short} {Math.round(value * 100)}%
            </span>
          );
        return (
          <span
            key={key}
            className={value ? "mark pass" : "mark bad"}
            title={why}
          >
            {value ? "✓" : "✗"} {short}
          </span>
        );
      })}
    </span>
  );
}

function Bar({
  side,
  tally,
}: {
  side: "with" | "without";
  tally: Tally | null;
}) {
  const name = side === "with" ? "With memory" : "Without memory";
  return (
    <div
      className={`bar bar-${side}`}
      title={tally ? `${name}: ${tally.counts}` : `${name}: n/a`}
    >
      <span className="bar-track">
        {tally && (
          <span className="bar-fill" style={{ width: `${tally.percent}%` }} />
        )}
      </span>
      <span className="bar-value">{tally ? `${tally.percent}%` : "n/a"}</span>
    </div>
  );
}

// Venue labels ("Melbourne (AU)") arrive on each trial's events.
const labels = new Map<string, string>();

function venueName(venue: string): string {
  return (
    labels.get(venue) ??
    venue.replace(
      /(^|-)([a-z])/g,
      (_, dash, letter) => `${dash ? " " : ""}${letter.toUpperCase()}`,
    )
  );
}

function sceneLabel(data: Record<string, unknown>): string {
  const venue = String(data.venue);
  if (typeof data.venue_label === "string") labels.set(venue, data.venue_label);
  const night = NIGHT_NAMES[String(data.night)] ?? String(data.night ?? "");
  return night ? `${venueName(venue)} · ${night}` : venueName(venue);
}

/** An event's text on one line, without markdown. */
function eventText(event: FeedEvent): string {
  if (event.type.startsWith("bank.") && typeof event.data.tool === "string")
    return toolLine(
      typeof event.data.server === "string" ? event.data.server : "trivia-bank",
      event.data.tool,
      (event.data.arguments as Record<string, unknown>) ?? {},
    );
  if (event.type === "memory.read" && !String(event.data.file ?? "").trim())
    return "No notes on file yet";
  return plainText(event.summary);
}

/** When the run began, from its id (`r` + epoch milliseconds). */
function runStartedAt(run: string): number | null {
  const at = Number(run.slice(1));
  return Number.isFinite(at) && at > 0 ? at : null;
}

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
    if (started.venue_label) labels.set(started.venue, started.venue_label);
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
  const [sceneNight, setSceneNight] = useState<string>();
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

  const trialList = view ? [...view.trials.values()] : [];
  const trialVenues = [
    ...new Set(trialList.map(({ started }) => started.venue)),
  ].sort();
  const filters = trialVenues;
  const shownVenue =
    sceneVenue && filters.includes(sceneVenue) ? sceneVenue : undefined;
  const shown = scenes.filter(
    (event) =>
      event.data.run === view?.run &&
      (!shownVenue || event.data.venue === shownVenue) &&
      (!sceneNight || event.data.night === sceneNight),
  );

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [shown.length, shownVenue, sceneNight]);

  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!running) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [running]);

  const done = trialList.filter(({ finished }) => finished).length;
  // Each venue plays night 1, night 2 with memory and night 2 without.
  const expected = trialVenues.length * 3;
  const measuresAt = (night: string) =>
    trialList
      .filter(({ started, finished }) => started.night === night && finished)
      .map(({ finished }) => finished!.measures ?? {});
  const withMemory = measuresAt("night2-hosted");
  const withoutMemory = measuresAt("night2-fresh");
  const comparison = compare(withMemory, withoutMemory);
  const compared = Math.max(withMemory.length, withoutMemory.length);
  const startedAt = view ? runStartedAt(view.run) : null;
  const elapsed = view?.finished
    ? view.finished.seconds
    : startedAt && now
      ? Math.max(0, Math.round((now - startedAt) / 1000))
      : null;

  const trialAt = (venue: string, night: string) =>
    view?.trials.get(`${venue}/${night}`);

  const toggle = (key: string) => setOpen(open === key ? undefined : key);

  const cell = (venue: string, night: string) => {
    const key = `${venue}/${night}`;
    const trial = trialAt(venue, night);
    if (!trial)
      return (
        <td key={key} className="trial pending">
          {view?.finished ? "—" : "waiting"}
        </td>
      );
    const { finished } = trial;
    const checks = finished ? Object.entries(finished.checks) : [];
    const failed = checks.filter(([, value]) => !value).map(([name]) => name);
    const previous =
      night === "night2-hosted"
        ? trialAt(venue, "night1-memory")?.finished?.notes
        : undefined;
    const chips = finished?.notes
      ? factChips(finished.notes, previous ?? undefined)
      : [];
    const preview =
      finished?.notes && !chips.length ? notesPreview(finished.notes) : null;
    return (
      <td
        key={key}
        className={open === key ? "trial open" : "trial"}
        onClick={() => toggle(key)}
      >
        <span className="status">
          {!finished ? (
            <span className="fine">running</span>
          ) : finished.reward === 1 ? (
            <span className="pass">✓ passed</span>
          ) : finished.reward === 0 ? (
            <span className="bad">✗ failed</span>
          ) : (
            <span className="fine">no reward</span>
          )}
          {finished && <span className="fine"> · {finished.seconds}s</span>}
          {finished?.trajectory_source &&
            finished.trajectory_source !== "sandbox" && (
              <span className="tag">{finished.trajectory_source}</span>
            )}
        </span>
        {checks.length > 0 && (
          <span className="checks">
            {failed.map((name) => (
              <span key={name} className="check bad">
                ✗ {name}
              </span>
            ))}
            <span className="fine check">
              {checks.length - failed.length}/{checks.length} checks
            </span>
          </span>
        )}
        {finished?.error && (
          <span className="bad error" title={finished.error}>
            {finished.error.split("\n")[0]}
          </span>
        )}
        {chips.length > 0 && (
          <span className="facts">
            {chips.map((chip) => (
              <span
                key={chip.key}
                className={chip.changed ? "fact changed" : "fact"}
                title={chip.changed ? "Changed since night 1" : undefined}
              >
                {chip.text}
              </span>
            ))}
          </span>
        )}
        {finished?.measures && <MeasureMarks measures={finished.measures} />}
        {preview && <span className="fine preview">{preview}</span>}
      </td>
    );
  };

  const detail = (venue: string, nights: string[]) => {
    const night = nights.find((item) => open === `${venue}/${item}`);
    const finished = night ? trialAt(venue, night)?.finished : undefined;
    if (!night) return null;
    return (
      <tr className="detail">
        <td colSpan={4}>
          <h3>
            {venueName(venue)} · {NIGHT_NAMES[night]}
          </h3>
          {!finished ? (
            <p className="fine">Still running.</p>
          ) : (
            <>
              <ul className="check-list">
                {Object.entries(finished.checks).map(([name, value]) => (
                  <li key={name} className={value ? "pass" : "bad"}>
                    {value ? "✓" : "✗"} {name}
                  </li>
                ))}
              </ul>
              {finished.error && <pre className="bad">{finished.error}</pre>}
              {finished.notes ? (
                <pre className="notes">{finished.notes}</pre>
              ) : (
                <p className="fine">No notes left.</p>
              )}
            </>
          )}
        </td>
      </tr>
    );
  };

  return (
    <div className="columns">
      <section className="platform">
        <div className="host-head">
          <div>
            <h2>
              On the platform <span className="tag">real evals</span>
            </h2>
            <p>
              Each venue plays night 1, then night 2 with its notes, and night 2
              again as a new customer, all at once.
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
            Venues
            <input
              type="number"
              min={1}
              max={config?.max_venues ?? 3}
              value={venues}
              onChange={(event) => setVenues(Number(event.target.value))}
            />
          </label>
          <button
            disabled={!config?.configured || !config?.target || running}
            onClick={start}
            title="Starts new venues with no memory: night 1 then night 2 at each, and each night 2 again without memory"
          >
            {running ? "Running…" : "Run"}
          </button>
          <span
            className="fine target"
            title={
              config?.target
                ? `Runtime ${config.target.runtime} at ${config.target.commit}`
                : undefined
            }
          >
            {config?.target
              ? targetLabel(
                  config.target.runtime,
                  config.target.commit,
                  config.target.slug,
                )
              : "…"}
          </span>
        </div>
        {config?.target_error && <p className="bad">{config.target_error}</p>}
        {error && <p className="bad">{error}</p>}

        {view && (
          <>
            <p className="fine run-summary">
              Run <code>{view.run}</code> · {done} of{" "}
              {view.finished?.trials ?? expected} done
              {elapsed !== null &&
                (view.finished
                  ? ` · ${elapsed}s total`
                  : ` · ${elapsed}s elapsed`)}
            </p>
            <div className="memory-chart">
              <h3>
                What memory changed
                {compared > 0 && (
                  <span className="fine">
                    {" "}
                    · night 2 at {compared} venue{compared === 1 ? "" : "s"}
                  </span>
                )}
              </h3>
              <p className="fine">
                Night 2 with memory reads the notes from night 1; night 2
                without is the same venue as a new customer, so the difference
                is what memory buys.
              </p>
              {comparison.length > 0 ? (
                <>
                  <div className="chart-legend fine" aria-hidden>
                    <span className="swatch swatch-without" /> without memory
                    <span className="swatch swatch-with" /> with memory
                  </div>
                  <ul className="chart-rows">
                    {comparison.map((row) => (
                      <li key={row.key} className="chart-row">
                        <span className="chart-label" title={row.why}>
                          {row.label}
                        </span>
                        <span className="chart-bars">
                          <Bar side="without" tally={row.without} />
                          <Bar side="with" tally={row.with} />
                        </span>
                        <strong
                          className={
                            row.difference === null
                              ? "chart-diff fine"
                              : row.difference > 0
                                ? "chart-diff pass"
                                : row.difference < 0
                                  ? "chart-diff bad"
                                  : "chart-diff"
                          }
                          title={
                            row.difference === null
                              ? "Needs both sides to compare"
                              : "With memory minus without, in points"
                          }
                        >
                          {row.difference === null
                            ? "n/a"
                            : signed(row.difference)}
                        </strong>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="fine">The chart fills in as night 2s finish.</p>
              )}
            </div>
            <table className="results">
              <colgroup>
                <col className="venue-col" />
                <col className="night-col" />
                <col className="night-col" />
                <col className="night-col" />
              </colgroup>
              <thead>
                <tr>
                  <th>Venue</th>
                  <th>Night 1</th>
                  <th>Night 2 with memory</th>
                  <th>Night 2 without</th>
                </tr>
              </thead>
              <tbody>
                {trialVenues.map((venue) => (
                  <Fragment key={venue}>
                    <tr>
                      <th scope="row">{venueName(venue)}</th>
                      {cell(venue, "night1-memory")}
                      {cell(venue, "night2-hosted")}
                      {cell(venue, "night2-fresh")}
                    </tr>
                    {detail(venue, [
                      "night1-memory",
                      "night2-hosted",
                      "night2-fresh",
                    ])}
                  </Fragment>
                ))}
              </tbody>
            </table>
            <p className="fine">Click a trial for its checks and notes.</p>
          </>
        )}
      </section>

      <aside className="scenes">
        <div className="scenes-head">
          <h2>Behind the scenes</h2>
        </div>
        <p className="fine">
          Each trial&apos;s tool calls and notes, streamed as it runs.
        </p>
        <nav className="venues scene-filters" aria-label="Venue">
          <button
            className={shownVenue ? undefined : "current"}
            onClick={() => setSceneVenue(undefined)}
          >
            All
          </button>
          {filters.map((item) => (
            <button
              key={item}
              className={item === shownVenue ? "current" : undefined}
              onClick={() => setSceneVenue(item)}
            >
              {venueName(item)}
            </button>
          ))}
        </nav>
        <nav className="venues scene-filters" aria-label="Night">
          {NIGHT_FILTERS.map(([night, label]) => (
            <button
              key={label}
              className={night === sceneNight ? "current" : undefined}
              onClick={() => setSceneNight(night)}
            >
              {label}
            </button>
          ))}
        </nav>
        <ol ref={log}>
          {shown.length === 0 && (
            <li className="empty">
              {view
                ? "Nothing here yet."
                : "Run the evals to see what the agent does."}
            </li>
          )}
          {shown.map((event) => {
            const text = eventText(event);
            return (
              <li key={event.seq}>
                <button
                  className="event"
                  title={text}
                  onClick={() =>
                    setOpenScene(
                      openScene === event.seq ? undefined : event.seq,
                    )
                  }
                >
                  <span className={`kind kind-${event.type.split(".")[0]}`}>
                    {kindLabel(event.type)}
                  </span>
                  <span className="who">{sceneLabel(event.data)}</span>
                  <span className="text">{text}</span>
                </button>
                {openScene === event.seq && (
                  <pre>
                    {typeof event.data.file === "string"
                      ? event.data.file || "(empty)"
                      : JSON.stringify(
                          event.data.arguments ?? event.data.edit ?? event.data,
                          null,
                          2,
                        )}
                  </pre>
                )}
              </li>
            );
          })}
        </ol>
      </aside>
    </div>
  );
}
