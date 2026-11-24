"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  EvalFinished,
  EvalRunFinished,
  EvalStarted,
  PlayedRound,
} from "@/lib/platform-evals";
import {
  factChips,
  firstSentences,
  kindLabel,
  notesPreview,
  roundLabel,
  targetLabel,
  toolLine,
} from "@/lib/display";
import {
  GATE_MIN,
  holm,
  lift,
  ordering,
  signTest,
  validityGate,
  type Pair,
} from "@/lib/experiment";
import type { Judgement } from "@/lib/judge";
import { BAND, MEASURES, checkLine } from "@/lib/memory-measures";
import {
  type Comparison,
  modelWhy,
  nextStep,
  otherWhy,
  trueWhy,
} from "@/lib/summary";

interface Config {
  configured: boolean;
  max_venues?: number;
  max_venues_by_pubs?: Record<Pubs, number>;
  team_sizes?: number[];
  default_teams?: number;
  /** An estimate of one trial's model cost, in US dollars. */
  cost_per_trial?: number;
  trials_per_venue?: number;
  missing: string | null;
  how_to: string;
  target: { runtime: string; commit: string; slug?: string } | null;
  target_error: string | null;
  active: string | null;
}

type Pubs = "development" | "heldout";

interface FeedEvent {
  seq: number;
  type: string;
  summary: string;
  data: Record<string, unknown>;
}

const MAX_STEPS = 3000;

interface Trial {
  started: EvalStarted;
  finished?: EvalFinished;
}

interface RunView {
  run: string;
  trials: Map<string, Trial>;
  finished?: EvalRunFinished;
}

// The night 2s from worst expected to best; night 0 only seeds the perfect notes.
const NIGHTS = [
  "night1-memory",
  "night2-wrong",
  "night2-fresh",
  "night2-hosted",
  "night2-perfect",
] as const;
type NightKey = (typeof NIGHTS)[number] | "night0-seed" | "night1-donor";

const NIGHT_TITLES: Record<NightKey, string> = {
  "night0-seed": "Night 0 · true notes seeded",
  "night1-donor": "Night 1 at another pub · the other notes",
  "night1-memory": "Night 1 · what it learned",
  "night2-wrong": "Night 2 · other notes",
  "night2-fresh": "Night 2 · no notes",
  "night2-hosted": "Night 2 · model notes",
  "night2-perfect": "Night 2 · true notes",
};

/** The bars, top to bottom: each night 2 arm, its label and its bar colour. */
const ARMS = [
  { night: "night2-perfect", label: "True notes", kind: "perfect" },
  { night: "night2-hosted", label: "Model notes", kind: "with" },
  { night: "night2-fresh", label: "No notes", kind: "without" },
  { night: "night2-wrong", label: "Other notes", kind: "wrong" },
] as const;
type ArmKind = (typeof ARMS)[number]["kind"];

/** Night 1, then night 2 four ways, each named for what it shows. */
/** How far one night has got across the run's pubs. */
interface ArmStatus {
  total: number;
  started: number;
  done: number;
  failed: number;
  /** Mean good rounds over the pubs that finished without failing. */
  good: number | null;
}

/** One box's status line: waiting, running n of N pubs, or done with its good rounds. */
function armStatusText(status: ArmStatus | undefined, night1 = false): string {
  if (!status || !status.started) return "waiting";
  const failed = status.failed ? ` · ${status.failed} failed` : "";
  // Kept to about 26 characters, the width of a box at 13px.
  if (status.done < status.total)
    return `${status.done}/${status.total} pubs done${failed}`;
  if (status.failed === status.total)
    return `failed · ${status.failed} of ${status.total} pubs`;
  if (night1 || status.good === null) return `done${failed}`;
  return `${points(status.good)}% good rounds${failed}`;
}

function ArmsDiagram({
  status = {},
}: {
  status?: Partial<Record<NightKey, ArmStatus>>;
}) {
  const boxX = (i: number) => 236 + i * 191;
  // Name at 15px, two 13px lines of explanation, then the live status.
  const Y = { box: 12, height: 94, name: 36, line1: 56, line2: 73, status: 95 };
  return (
    <svg
      className="arms-svg"
      viewBox="0 0 1000 116"
      role="img"
      aria-label="Night 1, then night 2 four ways: model notes (the host's own notes from night 1, the test), no notes (the baseline), other notes (another pub's, the placebo) and true notes (the crowd's real tastes, the ceiling)"
    >
      <defs>
        <marker
          id="arms-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0,0 L8,4 L0,8 z" fill="var(--muted)" />
        </marker>
      </defs>
      <rect
        x="1"
        y={Y.box}
        width="176"
        height={Y.height}
        rx="6"
        fill="var(--panel)"
        stroke="var(--line)"
      />
      <rect
        x="1"
        y={Y.box}
        width="5"
        height={Y.height}
        rx="2"
        fill="var(--ink)"
      />
      <text x="18" y={Y.name} className="arm-name">
        Night 1
      </text>
      <text x="18" y={Y.line1} className="arm-role">
        plays, writes notes
      </text>
      <text x="18" y={Y.status} className="arm-status">
        {armStatusText(status["night1-memory"], true)}
      </text>
      <path
        d={`M180,${Y.box + Y.height / 2} L222,${Y.box + Y.height / 2}`}
        stroke="var(--muted)"
        strokeWidth="1.5"
        markerEnd="url(#arms-arrow)"
      />
      {HOW_ARMS.map((arm, i) => (
        <g key={arm.name}>
          <rect
            x={boxX(i)}
            y={Y.box}
            width="186"
            height={Y.height}
            rx="6"
            fill="var(--panel)"
            stroke="var(--line)"
          />
          <rect
            x={boxX(i)}
            y={Y.box}
            width="5"
            height={Y.height}
            rx="2"
            fill={`var(${arm.color})`}
          />
          <text x={boxX(i) + 17} y={Y.name} className="arm-name">
            {arm.name}
          </text>
          <text x={boxX(i) + 17} y={Y.line1} className="arm-role">
            {arm.lines[0]}
          </text>
          <text x={boxX(i) + 17} y={Y.line2} className="arm-role">
            {arm.lines[1]}
          </text>
          <text x={boxX(i) + 17} y={Y.status} className="arm-status">
            {armStatusText(status[arm.night])}
          </text>
        </g>
      ))}
    </svg>
  );
}

/** Night 2's four ways, as the "How it's tested" diagram names and explains them. */
const HOW_ARMS = [
  {
    name: "Model notes",
    lines: ["the host's own notes", "from night 1 · the test"],
    color: "--memory",
    night: "night2-hosted",
  },
  {
    name: "No notes",
    lines: ["starts fresh, like a", "new pub · the baseline"],
    color: "--muted",
    night: "night2-fresh",
  },
  {
    name: "Other notes",
    lines: ["another pub's notes ·", "the placebo"],
    color: "--bad",
    night: "night2-wrong",
  },
  {
    name: "True notes",
    lines: ["the crowd's real tastes ·", "the ceiling"],
    color: "--host",
    night: "night2-perfect",
  },
] as const;

/** The primary measures: how far each round's share right was from 65%, and the share of rounds 55–75% right. */
const GOOD_ROUNDS = "good_rounds";

/** A share (0-1) as points, `0.12` as 12. */
const points = (value: number) => Math.round(value * 100);

/** A measure key in plain words: `favourite_genre` as "favourite genre". */
const measureLabel = (key: string) => key.replace(/_/g, " ");

/** The country code of a "City (CC)" label. */
const countryOf = (label: string) => /\(([^)]+)\)$/.exec(label)?.[1] ?? null;

function listWords(items: string[]): string {
  return items.length < 2
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** A venue as its city and, from a "City (CC)" label, its country code. */
function venueParts(trial: Trial | undefined, venue: string) {
  const label =
    trial?.started.venue_label ??
    venue.replace(
      /(^|-)([a-z])/g,
      (_, dash, letter) => `${dash ? " " : ""}${letter.toUpperCase()}`,
    );
  const match = /^(.*?)\s*\(([^)]+)\)$/.exec(label);
  return match ? `${match[1]} · ${match[2]}` : label;
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

/** A night 2's judge score and its reason, or why it has none. */
function Score({ judge }: { judge?: Judgement | null }) {
  if (!judge) return null;
  if (judge.score === null)
    return <span className="fine">judge: {judge.error ?? "no score"}</span>;
  return (
    <span className="score">
      <strong>{judge.score}/5</strong>
      {judge.reason && <span className="fine"> {judge.reason}</span>}
    </span>
  );
}

/** What a finished trial's card column says: night 1's facts, night 2's opening words. */
function Summary({
  night,
  finished,
}: {
  night: NightKey;
  finished: EvalFinished;
}) {
  const checks = Object.values(finished.checks);
  const missed = checks.filter((value) => !value).length;
  if (night === "night1-memory") {
    const chips = finished.notes ? factChips(finished.notes) : [];
    const preview =
      finished.notes && !chips.length ? notesPreview(finished.notes) : null;
    return (
      <>
        {chips.length > 0 ? (
          <span className="facts">
            {chips.map((chip) => (
              <span key={chip.key} className="fact">
                {chip.text}
              </span>
            ))}
          </span>
        ) : (
          <span className="fine">{preview ?? "No notes left."}</span>
        )}
        {finished.error ? (
          <span className="amber">error, see details</span>
        ) : (
          missed > 0 && (
            <span className="amber">
              missed {missed} of {checks.length} checks
            </span>
          )
        )}
      </>
    );
  }
  return (
    <>
      {night === "night2-wrong" && finished.donor_label && (
        <span className="fine">notes from {finished.donor_label}</span>
      )}
      {finished.plan ? (
        <q className="quote">{firstSentences(finished.plan)}</q>
      ) : (
        <span className="fine">No message.</span>
      )}
      <span className={finished.round ? "fact" : "fine"}>
        {finished.round ? roundLabel(finished.round) : "no round fetched"}
      </span>
      <Score judge={finished.judge} />
      {night === "night2-hosted" &&
        (finished.error ? (
          <span className="amber">error, see details</span>
        ) : (
          missed > 0 && (
            <span className="amber">
              missed {missed} of {checks.length} checks
            </span>
          )
        ))}
      {night !== "night2-hosted" && finished.error && (
        <span className="fine">error, see details</span>
      )}
    </>
  );
}

/** Each round as it was played: the questions with their answers, and which teams got each right. */
function Rounds({ rounds }: { rounds: PlayedRound[] }) {
  if (!rounds.length)
    return (
      <span className="fine">
        This night&apos;s questions weren&apos;t recorded.
      </span>
    );
  return (
    <ol className="round-list">
      {rounds.map((round) => (
        <li key={round.round}>
          <p className="round-head">
            <strong>Round {round.round}</strong> · {round.genre} · difficulty{" "}
            {round.difficulty}
            {round.correct_rate !== null &&
              ` · ${Math.round(round.correct_rate * 100)}% right`}
          </p>
          <ol className="question-list">
            {round.questions.map((question, index) => (
              <li key={index}>
                <span>{question.text ?? "The question wasn't recorded."}</span>
                {question.answer && (
                  <span className="answer"> {question.answer}</span>
                )}
                {question.marks.length > 0 && (
                  <span className="team-marks">
                    {question.marks.map((mark) => (
                      <span
                        key={mark.team}
                        className={
                          mark.correct ? "team-mark right" : "team-mark wrong"
                        }
                        title={`${mark.team}: ${mark.correct ? "right" : "wrong"}`}
                      >
                        {mark.correct ? "✓" : "✗"} {mark.team}
                      </span>
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </li>
      ))}
    </ol>
  );
}

type NightView = "questions" | "steps";

/** The night tabs, short enough to sit in one row. */
const TAB_LABELS: Record<(typeof NIGHTS)[number], string> = {
  "night1-memory": "Night 1",
  "night2-wrong": "Other notes",
  "night2-fresh": "No notes",
  "night2-hosted": "Model notes",
  "night2-perfect": "True notes",
};

/** A night's state for its tab: waiting, running, failed, or done with its good rounds. */
function nightStatus(
  trial: Trial | undefined,
  runDone: boolean,
): { kind: string; mark: string; title: string } {
  if (!trial)
    return runDone
      ? { kind: "skipped", mark: "—", title: "Didn't run" }
      : { kind: "waiting", mark: "·", title: "Waiting to start" };
  const finished = trial.finished;
  if (!finished) return { kind: "running", mark: "", title: "Running" };
  if (finished.error)
    return { kind: "failed", mark: "✗", title: finished.error };
  const good = finished.measures?.[GOOD_ROUNDS];
  return {
    kind: "done",
    mark: typeof good === "number" ? `✓ ${points(good)}%` : "✓",
    title:
      typeof good === "number" ? `Done: ${points(good)}% good rounds` : "Done",
  };
}

/** A failed night in one line; the raw message is its title and sits under the hood. */
function failureLine(finished: EvalFinished): string {
  if (finished.rounds?.length)
    return "Stopped part way: the platform task failed.";
  return /did not start|failed to start|fetch failed|Git fetch/i.test(
    finished.error ?? "",
  )
    ? "Didn't start: the platform task failed."
    : "Didn't finish: the platform task failed.";
}

/** A night as the room saw it: what night 1 learned or whose notes it had, then its rounds. */
function NightQuestions({
  night,
  finished,
}: {
  night: NightKey;
  finished: EvalFinished;
}) {
  const chips =
    night === "night1-memory" && finished.notes
      ? factChips(finished.notes)
      : [];
  return (
    <>
      {finished.error && (
        <p className="fine" title={finished.error}>
          {failureLine(finished)}
        </p>
      )}
      {chips.length > 0 && (
        <span className="facts">
          {chips.map((chip) => (
            <span key={chip.key} className="fact">
              {chip.text}
            </span>
          ))}
        </span>
      )}
      {night === "night2-wrong" && finished.donor_label && (
        <p className="fine">Notes from {finished.donor_label}.</p>
      )}
      {(!finished.error || (finished.rounds?.length ?? 0) > 0) && (
        <Rounds rounds={finished.rounds ?? []} />
      )}
    </>
  );
}
const NIGHT_VIEW_KEY = "trivia-night:night-view";

/** One step of a trial, from its trajectory. */
function Step({ event }: { event: FeedEvent }) {
  const kind = (
    <span className={`kind kind-${event.type.split(".")[0]}`}>
      {kindLabel(event.type)}
    </span>
  );
  const error =
    typeof event.data.error === "string" ? (
      <span className="step-error"> {event.data.error}</span>
    ) : null;
  if (event.type === "memory.read") {
    const file = String(event.data.file ?? "").trim();
    // Events recorded before the step builder knew a missing file carry its error as the file.
    if (!file || /ENOENT|no such file/i.test(file))
      return (
        <li>
          {kind} Loading memory{" "}
          <span className="fine">· none yet — first visit</span>
          {error}
        </li>
      );
    return (
      <li>
        {kind} Loading memory
        <pre>{file}</pre>
      </li>
    );
  }
  if (event.type === "memory.written")
    return (
      <li>
        <details>
          <summary>{kind} Saving memory</summary>
          <pre>
            {typeof event.data.file === "string"
              ? event.data.file
              : JSON.stringify(event.data.edit, null, 2)}
          </pre>
        </details>
      </li>
    );
  if (event.type === "host.planned") {
    const plan = String(event.data.file ?? "");
    return (
      <li>
        <details>
          <summary>
            {kind} {firstSentences(plan, 1, 100) || "Planning"}
          </summary>
          <pre className="plan">{plan}</pre>
        </details>
      </li>
    );
  }
  if (event.type.startsWith("bank.") && typeof event.data.tool === "string")
    return (
      <li>
        {kind}{" "}
        {toolLine(
          typeof event.data.server === "string"
            ? event.data.server
            : "trivia-bank",
          event.data.tool,
          (event.data.arguments as Record<string, unknown>) ?? {},
        )}
        {error}
      </li>
    );
  return (
    <li>
      {kind} {event.summary}
    </li>
  );
}

export function PlatformEvals() {
  const [config, setConfig] = useState<Config>();
  const [venues, setVenues] = useState(3);
  const [teams, setTeams] = useState<number>();
  const [pubs, setPubs] = useState<Pubs>("development");
  const maxVenues =
    config?.max_venues_by_pubs?.[pubs] ?? config?.max_venues ?? 1;
  const [view, setView] = useState<RunView>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<string>();
  const [nightView, setNightView] = useState<NightView>("questions");
  const [tabs, setTabs] = useState<Record<string, (typeof NIGHTS)[number]>>({});
  useEffect(() => {
    try {
      if (window.localStorage.getItem(NIGHT_VIEW_KEY) === "steps")
        setNightView("steps");
    } catch {
      // Storage blocked: the default view stays.
    }
  }, []);
  const chooseView = (view: NightView) => {
    setNightView(view);
    try {
      window.localStorage.setItem(NIGHT_VIEW_KEY, view);
    } catch {
      // Storage blocked: the choice lasts for this page only.
    }
  };
  const [steps, setSteps] = useState<FeedEvent[]>([]);
  const cursor = useRef(0);

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
    // event already kept is skipped rather than kept again.
    setSteps((current) => {
      const seen = new Set(current.map((event) => event.seq));
      const fresh = more.events.filter(
        (event) =>
          !event.type.startsWith("eval.") &&
          typeof event.data.venue === "string" &&
          !seen.has(event.seq),
      );
      return fresh.length ? [...current, ...fresh].slice(-MAX_STEPS) : current;
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

  // A run of one venue has no other pub's night 1 or wrong-notes night 2.
  const trialsFor = (count: number) =>
    count * (config?.trials_per_venue ?? 7) - (count === 1 ? 2 : 0);
  const setSize = (set: Pubs) =>
    config?.max_venues_by_pubs?.[set] ?? (set === "development" ? 11 : 20);
  const trialsPerPub = config?.trials_per_venue ?? 7;
  const pubCost = (trialsPerPub * (config?.cost_per_trial ?? 0.086)).toFixed(2);
  const venueCount = Math.min(Math.max(Math.trunc(venues) || 1, 1), maxVenues);
  const trials = trialsFor(venueCount);

  const start = async () => {
    setError(undefined);
    const response = await fetch("/api/evals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        venues: venueCount,
        teams: teams ?? config?.default_teams,
        pubs,
      }),
    });
    const body = await response.json();
    if (!response.ok) setError(body.error);
    else setConfig((current) => current && { ...current, active: body.run });
    await poll();
  };

  const trialList = view ? [...view.trials.values()] : [];
  const trialVenues = [
    ...new Set(trialList.map(({ started }) => started.venue)),
  ];
  const done = trialList.filter(({ finished }) => finished).length;
  const expected = view?.finished?.trials ?? trialsFor(trialVenues.length);
  const finishedAt = (night: NightKey) =>
    trialList
      .filter(({ started, finished }) => started.night === night && finished)
      .map(({ finished }) => finished!);
  // A perfect-notes night 2 counts only when night 0 seeded exactly the true notes.
  const counted = (venue: string, night: NightKey) =>
    night !== "night2-perfect" ||
    view?.trials.get(`${venue}/night0-seed`)?.finished?.checks.notes_seeded ===
      1;
  const scoreOf = (venue: string, night: NightKey) =>
    counted(venue, night)
      ? (view?.trials.get(`${venue}/${night}`)?.finished?.judge?.score ?? null)
      : null;
  const measureAt = (venue: string, night: NightKey, key: string) => {
    if (!counted(venue, night)) return null;
    const finished = view?.trials.get(`${venue}/${night}`)?.finished;
    const value = (finished?.measures as Record<string, number> | undefined)?.[
      key
    ];
    if (typeof value === "number") return value;
    // Runs before the verifier printed it: the first round's share right says the same.
    const opening = finished?.fetches?.[0]?.correct_rate;
    if (key === "first_round_in_band" && typeof opening === "number")
      return opening >= BAND[0] && opening <= BAND[1] ? 1 : 0;
    return null;
  };
  const pairedOf = (
    of: (venue: string, night: NightKey) => number | null,
    a: NightKey,
    b: NightKey,
  ) =>
    trialVenues.flatMap((venue): Pair[] => {
      const x = of(venue, a);
      const y = of(venue, b);
      return x !== null && y !== null ? [{ with: x, without: y }] : [];
    });
  const countries = [
    ...new Set(
      trialList
        .map(({ started }) => countryOf(started.venue_label ?? ""))
        .filter((code): code is string => Boolean(code)),
    ),
  ].sort();
  type Row = {
    key: string;
    label: string;
    why: string;
    primary: boolean;
    bars: { label: string; kind: ArmKind; text: string; share: number }[];
    means: Partial<Record<ArmKind, number>>;
    verdict: string;
    tone: string;
    /** The right-vs-none sign test's p, Holm-adjusted across secondary rows later. */
    p: number;
    wrong: { text: string; tone: string } | null;
  };
  const percent = (value: number | null) =>
    value === null ? "–" : `${points(value)}%`;
  const meanOf = (values: number[]) =>
    values.length
      ? values.reduce((sum, v) => sum + v, 0) / values.length
      : null;
  const rowFor = (
    key: string,
    label: string,
    why: string,
    primary: boolean,
    of: (venue: string, night: NightKey) => number | null,
    show: (value: number | null) => string,
    scale: [number, number] = [0, 1],
  ): Row | null => {
    const pairs = pairedOf(of, "night2-hosted", "night2-fresh");
    const result = lift(pairs);
    if (!result) return null;
    const means: Row["means"] = {};
    const bars = ARMS.flatMap((arm) => {
      const mean = meanOf(
        trialVenues
          .map((venue) => of(venue, arm.night))
          .filter((v): v is number => v !== null),
      );
      if (mean === null) return [];
      means[arm.kind] = mean;
      return [
        {
          label: arm.label,
          kind: arm.kind,
          text: show(mean),
          share: fraction(mean, scale),
        },
      ];
    });
    const verdict =
      result.verdict === "supported"
        ? "Better"
        : result.verdict === "not supported"
          ? "Worse"
          : `Better at ${result.higher} of ${result.pubs}`;
    const tone =
      result.verdict === "supported"
        ? "good"
        : result.verdict === "not supported"
          ? "bad"
          : "fine";
    const versusWrong = signTest(
      pairedOf(of, "night2-hosted", "night2-wrong").map(
        (p) => p.with - p.without,
      ),
    );
    const compared = versusWrong.positive + versusWrong.negative;
    const wrongPairs = pairedOf(of, "night2-hosted", "night2-wrong").length;
    return {
      key,
      label,
      why,
      primary,
      bars,
      means,
      verdict,
      tone,
      p: signTest(pairs.map((p) => p.with - p.without)).p,
      wrong: wrongPairs
        ? {
            text: `vs other notes: better at ${versusWrong.positive} of ${wrongPairs}`,
            tone:
              compared && versusWrong.p < 0.05
                ? versusWrong.positive > versusWrong.negative
                  ? "good"
                  : "bad"
                : "fine",
          }
        : null,
    };
  };
  // Every row reads "longer bar is better": a lower-is-better measure is shown as its complement.
  const measureRow = (key: string, label: string, primary = false) => {
    const meta = MEASURES[key as keyof typeof MEASURES];
    const flip = meta?.better === "lower";
    return rowFor(
      key,
      label,
      meta?.why ?? "",
      primary,
      (venue, night) => {
        const value = measureAt(venue, night, key);
        return value === null ? null : flip ? 1 - value : value;
      },
      percent,
    );
  };
  // The three measures shown up front: good rounds, and the two that explain it (taste and level).
  const built = [
    measureRow(
      GOOD_ROUNDS,
      "Good rounds (a genre the crowd loves and 55–75% right)",
      true,
    ),
    measureRow("favourite_genre", "Loved genres played"),
    measureRow("first_round_in_band", "First round pitched right"),
  ].filter((row): row is Row => row !== null);
  // Under the hood: how the night felt, which doesn't test memory, and the rest.
  const experienceRows = [
    measureRow("close_finish", "How close the finish was"),
    measureRow(
      "lead_changes",
      "Lead changes (share of rounds after the first)",
    ),
    measureRow(
      "bottom_share",
      "Last place's points, as a share of the winner's",
    ),
  ].filter((row): row is Row => row !== null);
  const otherRows = [
    measureRow("in_band", "Rounds 55–75% right"),
    rowFor(
      "judge",
      "Judge: how tailored it felt (1–5)",
      "A model judge's 1–5 score of how well night 2 suited this crowd",
      false,
      scoreOf,
      (value) => (value === null ? "–" : value.toFixed(1)),
      [1, 5],
    ),
  ].filter((row): row is Row => row !== null);
  // Secondary rows are called better or worse only past a Holm-corrected sign test.
  const secondary = built.filter((row) => !row.primary);
  const adjusted = holm(secondary.map((row) => row.p));
  const rows = built.map((row) => {
    if (row.primary) return row;
    const p = adjusted[secondary.indexOf(row)];
    const right = row.means.with ?? 0;
    const none = row.means.without ?? 0;
    return p < 0.05
      ? {
          ...row,
          verdict: right > none ? "Better" : "Worse",
          tone: right > none ? "good" : "bad",
        }
      : {
          ...row,
          verdict: row.verdict.startsWith("Better at")
            ? row.verdict
            : row.verdict.replace(/^(Better|Worse)$/, (word) => `${word}?`),
          tone: "fine",
        };
  });
  const primary = rows.find((row) => row.primary);
  // Each arm against no notes at the same pubs, for the summary's reasons.
  const mean = (values: number[]) =>
    values.reduce((a, b) => a + b, 0) / (values.length || 1);
  const compare = (night: NightKey): Comparison | null => {
    const pubs = trialVenues.filter(
      (venue) =>
        measureAt(venue, night, GOOD_ROUNDS) !== null &&
        measureAt(venue, "night2-fresh", GOOD_ROUNDS) !== null,
    );
    if (!pubs.length) return null;
    const stats = (arm: NightKey) => ({
      good: mean(pubs.map((v) => measureAt(v, arm, GOOD_ROUNDS) ?? 0)),
      loved: mean(pubs.map((v) => measureAt(v, arm, "favourite_genre") ?? 0)),
      firstHits: pubs.filter(
        (v) => measureAt(v, arm, "first_round_in_band") === 1,
      ).length,
    });
    return {
      pubs: pubs.length,
      arm: stats(night),
      none: stats("night2-fresh"),
    };
  };
  const modelVsNone = compare("night2-hosted");
  const reasons = [
    modelWhy(modelVsNone),
    otherWhy(compare("night2-wrong")),
    trueWhy(compare("night2-perfect"), modelVsNone),
  ].filter((line): line is string => line !== null);
  const order =
    primary &&
    typeof primary.means.with === "number" &&
    typeof primary.means.without === "number" &&
    typeof primary.means.wrong === "number"
      ? ordering({
          perfect: primary.means.perfect ?? null,
          right: primary.means.with,
          none: primary.means.without,
          wrong: primary.means.wrong,
        })
      : null;
  const pubCount = pairedOf(
    (venue, night) => measureAt(venue, night, GOOD_ROUNDS),
    "night2-hosted",
    "night2-fresh",
  ).length;
  const headline = !rows.length
    ? running
      ? "Waiting for the night 2s at a pub…"
      : "No results yet."
    : !order
      ? `Model notes vs no notes, across ${pubCount} pub${pubCount === 1 ? "" : "s"}: ${primary?.verdict.toLowerCase() ?? "no result"} on good rounds; waiting for the other notes.`
      : order.holds &&
          primary?.verdict === "Better" &&
          primary.wrong?.tone === "good"
        ? "Memory helps because of what it remembered: model notes beat no notes, and other notes did worst."
        : order.holds
          ? `In the expected order on good rounds across ${pubCount} pubs, but not yet supported by the pre-registered tests: model notes need an interval above no notes and a sign-test win over other notes.`
          : `On good rounds across ${pubCount} pubs: model notes ${order.rightOverNone ? "beat" : "did not beat"} no notes, no notes ${order.noneOverWrong ? "beat" : "did not beat"} other notes${
              typeof primary?.means.perfect === "number"
                ? `, and true notes ${order.perfectAtLeastRight ? "matched or beat" : "fell short of"} model notes`
                : ""
            }.`;
  const gate = validityGate(
    trialVenues.flatMap((venue) => {
      const perfect = measureAt(venue, "night2-perfect", GOOD_ROUNDS);
      const none = measureAt(venue, "night2-fresh", GOOD_ROUNDS);
      return perfect !== null && none !== null ? [{ perfect, none }] : [];
    }),
  );
  const goodLift = lift(
    pairedOf(
      (venue, night) => measureAt(venue, night, GOOD_ROUNDS),
      "night2-hosted",
      "night2-fresh",
    ),
  );
  const night2Keys = NIGHTS.filter((night) => night.startsWith("night2-"));
  const missingNights = trialVenues.filter((venue) =>
    night2Keys.some((night) => {
      const trial = view?.trials.get(`${venue}/${night}`);
      return trial?.finished ? Boolean(trial.finished.error) : view?.finished;
    }),
  ).length;
  const suggestion = view?.finished
    ? nextStep({
        pubSet: trialVenues.some((venue) => venue.startsWith("held-"))
          ? "heldout"
          : "development",
        pubsRun: trialVenues.length,
        developmentPubs: config?.max_venues_by_pubs?.development ?? 11,
        heldoutPubs: config?.max_venues_by_pubs?.heldout ?? 20,
        intervalIncludesZero:
          !goodLift?.interval ||
          (goodLift.interval[0] <= 0 && goodLift.interval[1] >= 0),
        missingNights,
        gatePasses: gate?.passes ?? null,
        costPerTrial: config?.cost_per_trial ?? 0.086,
        trialsPerPub: config?.trials_per_venue ?? 7,
      })
    : null;
  const accuracy = trialVenues.flatMap((venue) => {
    const value = measureAt(venue, "night1-memory", "notes_accuracy");
    return value === null
      ? []
      : [
          {
            venue,
            label: venueParts(
              view?.trials.get(`${venue}/night1-memory`),
              venue,
            ),
            value,
          },
        ];
  });
  const night2s = [
    ...finishedAt("night2-hosted"),
    ...finishedAt("night2-fresh"),
    ...finishedAt("night2-wrong"),
    ...finishedAt("night2-perfect"),
  ];
  const judgeError = night2s.find((finished) => finished.judge?.error)?.judge
    ?.error;

  const armStatus = (night: NightKey): ArmStatus => {
    const runs = trialVenues.map((venue) =>
      view?.trials.get(`${venue}/${night}`),
    );
    const finished = runs.flatMap((t) => (t?.finished ? [t.finished] : []));
    const goods = finished
      .filter((f) => !f.error)
      .map((f) => f.measures?.[GOOD_ROUNDS])
      .filter((g): g is number => typeof g === "number");
    return {
      total: trialVenues.length,
      started: runs.filter(Boolean).length,
      done: finished.length,
      failed: finished.filter((f) => f.error).length,
      good: goods.length
        ? goods.reduce((a, b) => a + b, 0) / goods.length
        : null,
    };
  };
  const armStatuses = Object.fromEntries(
    NIGHTS.map((night) => [night, armStatus(night)]),
  ) as Partial<Record<NightKey, ArmStatus>>;
  const trialAt = (venue: string, night: NightKey) =>
    view?.trials.get(`${venue}/${night}`);
  const stepsOf = (venue: string, night: NightKey) =>
    steps.filter(
      (event) =>
        event.data.run === view?.run &&
        event.data.venue === venue &&
        event.data.night === night,
    );

  const card = (venue: string) => {
    const trials = NIGHTS.map((night) => trialAt(venue, night));
    const expanded = open === venue;
    const firstDone = NIGHTS.find((_, i) => trials[i]?.finished);
    const chosen: (typeof NIGHTS)[number] =
      tabs[venue] ??
      (trials[NIGHTS.indexOf("night2-hosted")]?.finished
        ? "night2-hosted"
        : (firstDone ?? "night2-hosted"));
    const trial = trials[NIGHTS.indexOf(chosen)];
    const finished = trial?.finished;
    return (
      <article
        key={venue}
        className={expanded ? "venue-card open" : "venue-card"}
      >
        <header
          className="card-head"
          onClick={() => setOpen(expanded ? undefined : venue)}
        >
          <h3>{venueParts(trials.find(Boolean), venue)}</h3>
        </header>
        <div className="night-tabs" role="tablist" aria-label="Nights">
          {NIGHTS.map((night, i) => {
            const status = nightStatus(trials[i], Boolean(view?.finished));
            return (
              <button
                key={night}
                type="button"
                role="tab"
                aria-selected={expanded && night === chosen}
                className={`night-tab ${status.kind}`}
                title={status.title}
                onClick={() => {
                  setTabs((current) => ({ ...current, [venue]: night }));
                  setOpen(venue);
                }}
              >
                {TAB_LABELS[night]}{" "}
                <span className="tab-mark">
                  {status.kind === "running" ? (
                    <span className="spinner" aria-hidden />
                  ) : (
                    status.mark
                  )}
                </span>
              </button>
            );
          })}
        </div>
        {expanded && (
          <div className="night-body">
            {!finished ? (
              <span className="fine">
                {trial
                  ? "Running…"
                  : view?.finished
                    ? "This night didn't run."
                    : "Waiting to start."}
              </span>
            ) : nightView === "questions" ? (
              <NightQuestions night={chosen} finished={finished} />
            ) : (
              <>
                {chosen === "night2-wrong" &&
                  trialAt(venue, "night1-donor")?.finished && (
                    <div className="hood-summary">
                      <h5 className="verifiers">
                        {NIGHT_TITLES["night1-donor"]}{" "}
                        <span className="fine">
                          played first, as this customer, to write the notes
                          night 2 loads
                        </span>
                      </h5>
                      <Summary
                        night="night1-donor"
                        finished={trialAt(venue, "night1-donor")!.finished!}
                      />
                    </div>
                  )}
                <div className="hood-summary">
                  <Summary night={chosen} finished={finished} />
                </div>
                <ol className="step-list">
                  {stepsOf(venue, chosen).map((event) => (
                    <Step key={event.seq} event={event} />
                  ))}
                </ol>
                <h5 className="verifiers">
                  Verifiers{" "}
                  <span className="fine">
                    what the eval&apos;s verifier measured for this night
                  </span>
                </h5>
                <ul className="check-list">
                  {Object.entries(finished.checks).map(([name, value]) => {
                    const line = checkLine(name, value, finished.fetches ?? []);
                    return line.pass === undefined ? (
                      <li key={name}>{line.text}</li>
                    ) : (
                      <li key={name} className={line.pass ? "pass" : "fine"}>
                        {line.text} {line.pass ? "✓" : "✗"}
                      </li>
                    );
                  })}
                </ul>
                <span className="fine">
                  reward {finished.reward ?? "none"} · {finished.seconds}s
                  {finished.trajectory_source &&
                    finished.trajectory_source !== "sandbox" &&
                    ` · ${finished.trajectory_source}`}
                </span>
                {finished.error && <pre>{finished.error}</pre>}
              </>
            )}
          </div>
        )}
      </article>
    );
  };

  const barRow = (row: Row) => (
    <div className="bar-row" key={row.key} title={row.why}>
      <div className="bar-label">
        {row.label}
        <span className={`bar-verdict ${row.tone}`}>
          {row.verdict}
          {row.wrong && (
            <small className={`bar-verdict ${row.wrong.tone}`}>
              {row.wrong.text}
            </small>
          )}
        </span>
      </div>
      {row.bars.map((bar) => (
        <Bar
          key={bar.kind}
          label={bar.label}
          text={bar.text}
          share={bar.share}
          kind={bar.kind}
        />
      ))}
    </div>
  );

  return (
    <section className="platform">
      <div className="host-head">
        <div>
          <p>
            Each pub plays night 1, then night 2 four ways: model notes, no
            notes, other notes and true notes. Try a few development pubs; the
            held-out set is kept for the final result.
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
        <div className="control">
          <span className="control-label" id="pub-set-label">
            Pub set
          </span>
          <div className="seg" role="group" aria-labelledby="pub-set-label">
            {(
              [
                ["development", "Development"],
                ["heldout", "Held-out"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={pubs === value}
                disabled={running}
                title={`${setSize(value)} pubs; a pub costs about $${pubCost} (${trialsPerPub} trials) in either set`}
                onClick={() => {
                  setPubs(value);
                  setVenues(setSize(value));
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="control">
          <span className="control-label" id="pubs-label">
            Pubs
          </span>
          <div className="stepper" role="group" aria-labelledby="pubs-label">
            <button
              type="button"
              aria-label="Fewer pubs"
              disabled={running || venueCount <= 1}
              onClick={() => setVenues(venueCount - 1)}
            >
              −
            </button>
            <output aria-live="polite">{venueCount}</output>
            <button
              type="button"
              aria-label="More pubs"
              disabled={running || venueCount >= maxVenues}
              onClick={() => setVenues(venueCount + 1)}
            >
              +
            </button>
          </div>
        </div>
        <div
          className="control"
          title="The teams that play at each pub; tasks exist for 3, 5 and 8"
        >
          <span className="control-label" id="teams-label">
            Teams per pub
          </span>
          <div className="seg" role="group" aria-labelledby="teams-label">
            {(config?.team_sizes ?? [3, 5, 8]).map((size) => (
              <button
                key={size}
                type="button"
                aria-pressed={(teams ?? config?.default_teams ?? 5) === size}
                disabled={running}
                onClick={() => setTeams(size)}
              >
                {size}
              </button>
            ))}
          </div>
        </div>
        <button
          disabled={!config?.configured || !config?.target || running}
          onClick={start}
          title="Starts new pubs with no memory: night 1, then night 2 with model notes, no notes, other notes and true notes"
        >
          {running ? "Running…" : "Run"}
        </button>
        {config?.cost_per_trial !== undefined && (
          <span
            className="fine cost"
            title="Sonnet 5.5 list price, measured per trial; billed to your organization's platform usage"
          >
            Estimated cost ${(trials * config.cost_per_trial).toFixed(2)} ·{" "}
            {trials} trials
          </span>
        )}
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
            {view.finished ? (
              <>
                Run <code>{view.run}</code> · {done} of {expected} trials ·{" "}
                {view.finished.seconds}s
              </>
            ) : (
              <>
                <span className="spinner" aria-hidden /> Running… {done} of{" "}
                {expected} trials
              </>
            )}
          </p>
          <div className="experiment">
            <div className="pick">
              <p className="big">{headline}</p>
              {reasons.length > 0 && (
                <ul className="reasons">
                  {reasons.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
              {suggestion && (
                <p className="next-step">
                  <strong>Next:</strong> {suggestion}
                </p>
              )}
              {pubCount > 0 && (
                <p className="fine">
                  Night 2 at the same {pubCount} pub
                  {pubCount === 1 ? "" : "s"}, the same teams answering, with
                  model notes, no notes, other notes and true notes.
                </p>
              )}
              {gate && (
                <p className={gate.passes ? "fine" : "amber"}>
                  World check: true notes beat no notes by{" "}
                  {points(gate.difference)} pts (needs ≥ {points(GATE_MIN)} pts){" "}
                  {gate.passes ? "✓" : "✗"}
                </p>
              )}
            </div>
            {accuracy.length > 0 && (
              <div className="accuracy" title={MEASURES.notes_accuracy.why}>
                <strong>Night 1 notes matched the crowd</strong>{" "}
                {accuracy.map((item) => (
                  <span key={item.venue} className="fact">
                    {item.label} {points(item.value)}%
                  </span>
                ))}
              </div>
            )}
            {rows.length > 0 && (
              <div className="bars">
                <p className="fine bars-key">
                  Longer bar is better on every row.
                </p>
                {rows.map(barRow)}
              </div>
            )}
            {nightView === "steps" && experienceRows.length > 0 && (
              <div className="bars">
                <p className="fine bars-key">
                  <strong>Experience measures (don&apos;t test memory)</strong>
                </p>
                {experienceRows.map(barRow)}
                {otherRows.map(barRow)}
              </div>
            )}
            {judgeError && <p className="amber">Judge: {judgeError}</p>}
            <details className="fine how">
              <summary>How it&apos;s tested</summary>
              <p>
                <strong>The bet:</strong> notes from night 1 make night 2 fit
                the crowd: topics they like, pitched so most answers land.
              </p>
              <ArmsDiagram status={armStatuses} />
              <ul>
                <li>
                  The same teams answer every night 2, so only the host&apos;s
                  choices differ.
                </li>
                <li>
                  Scored on <strong>good rounds</strong>: a topic the crowd
                  loves, with 55–75% of answers right.
                </li>
                <li>
                  No AI answers the questions. Each team&apos;s chance of a
                  right answer comes from its members&apos; interests and ages,
                  whether the question is local to their country, and its
                  difficulty, rolled with a fixed seed: the same team answers
                  the same question the same way on every night and in every
                  arm.
                </li>
                <li>
                  A difference counts when its 95% range over the{" "}
                  {trialVenues.length} pub{trialVenues.length === 1 ? "" : "s"}
                  {countries.length > 0 && ` (${listWords(countries)})`} leaves
                  out zero.
                </li>
              </ul>
            </details>
          </div>
          <div className="cards-head">
            <div className="view-toggle" role="group" aria-label="View">
              <button
                type="button"
                aria-pressed={nightView === "questions"}
                onClick={() => chooseView("questions")}
              >
                Questions
              </button>
              <button
                type="button"
                aria-pressed={nightView === "steps"}
                onClick={() => chooseView("steps")}
              >
                Under the hood
              </button>
            </div>
            <span className="fine">Click a night to see its rounds.</span>
          </div>
          <div className="venue-cards">{trialVenues.map(card)}</div>
        </>
      )}
    </section>
  );
}

/** A value's position on its scale, 0 to 1. */
const fraction = (value: number, [low, high]: [number, number]) =>
  Math.min(Math.max((value - low) / (high - low || 1), 0), 1);

/** One labelled horizontal bar. */
function Bar({
  label,
  text,
  share,
  kind,
}: {
  label: string;
  text: string;
  share: number;
  kind: ArmKind;
}) {
  return (
    <div className="bar">
      <span className="bar-name">{label}</span>
      <span className="bar-track">
        <span
          className={`bar-fill ${kind}`}
          style={{ width: `${Math.max(share * 100, 1.5)}%` }}
        />
      </span>
      <span className="bar-value">{text}</span>
    </div>
  );
}
