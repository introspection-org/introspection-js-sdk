/**
 * The memory evals as cloud trials of the deployed `trivia-host` Runtime: the
 * plan of a run, what each trial task records about itself, and what its
 * verifier printed. platform-runner.ts makes the platform calls; everything
 * here is pure.
 */
import HELDOUT from "../recipe-operator/evals/heldout.json";
import VENUES from "../recipe-operator/evals/venues.json";
import type { Fetch, Measures, VenueTastes } from "./memory-measures";
import { hostEvents, type TrialEvent } from "./trial-steps";
import type { TaskVerification } from "@introspection-sdk/introspection-node";

/** A venue profile's task pair, as `pnpm evals:venues` writes it. */
export interface VenueProfile {
  slug: string;
  label: string;
  region: string;
  /** The crowd's favourite genres, to pick a donor pub with other tastes. */
  liked?: string[];
}

/**
 * The night's role; the Harbor task it runs is `Step.task`. `night2-fresh` is
 * the venue's night 2 as a new customer, with no notes; `night2-wrong` runs as
 * a customer of its own whose memory `night1-donor` wrote by playing another
 * pub's night 1, so it loads that pub's night-1 notes; `night0-seed` writes
 * the venue's true notes for `night2-perfect`.
 */
export type Night =
  | "night0-seed"
  | "night1-memory"
  | "night1-donor"
  | "night2-hosted"
  | "night2-fresh"
  | "night2-wrong"
  | "night2-perfect";

/** Which notes a night 2 had: its own night 1's, none, another pub's, or the true ones. */
export type Variant = "with" | "without" | "wrong" | "perfect";

/** Development pubs are for building the host; held-out pubs only for the preregistered run. */
export type Pubs = "development" | "heldout";
export const PUB_SETS: Record<Pubs, VenueProfile[]> = {
  development: VENUES,
  heldout: HELDOUT,
};
export const isPubs = (value: unknown): value is Pubs =>
  value === "development" || value === "heldout";

export interface Target {
  runtime: string;
  commit: string;
  /** The runtime's slug, for display. */
  slug?: string;
  /** The repository holding the Runtime's Recipe, which the trials' tasks are read from. */
  repository?: string;
  /** The Recipe's folder in that repository; empty for its root. */
  recipe_path?: string;
}

export type Step = {
  run: string;
  venue: string;
  /** The venue's display name, such as "Melbourne (AU)". */
  venue_label: string;
  night: Night;
  /** The Harbor task under evals/harbor, such as night1-melbourne. */
  task: string;
  identity: string;
  variant?: Variant;
  /** Steps (`stepKey`) this one waits for; the first's notes are its night-1 notes. */
  after?: string[];
  /** The pub whose night 1 wrote a wrong-notes night 2's notes. */
  donor?: string;
  donor_label?: string;
  /** The signed-in member who started the run, by id. */
  started_by?: string;
};

export const stepKey = (step: { venue: string; night: string }) =>
  `${step.venue}/${step.night}`;

export type EvalStarted = Step;

export type EvalFinished = Step & {
  reward: number | null;
  checks: Record<string, number>;
  notes: string | null;
  /** Absent on trials recorded before measures existed. */
  measures?: Measures;
  /** Each round it fetched, from the verifier. */
  fetches?: Fetch[];
  /** Each round as played: its questions, their answers and each team's mark. */
  rounds?: PlayedRound[];
  /** What the host did, from the result file; absent before the verifier wrote it. */
  steps?: TrialEvent[];
  /** Why the verifier has no steps for the night. */
  steps_error?: string | null;
  seconds: number;
  exit_code: number | null;
  error: string | null;
};

export type EvalRunFinished = {
  run: string;
  seconds: number;
  trials: number;
  started_by?: string;
};

export const MAX_VENUES = VENUES.length;
export const MAX_VENUES_BY_PUBS: Record<Pubs, number> = {
  development: VENUES.length,
  heldout: HELDOUT.length,
};
/** The crowd sizes each venue has tasks for, as evals/venues.mjs writes them; 5 is unsuffixed. */
export const TEAM_SIZES = [3, 5, 8] as const;
export type TeamSize = (typeof TEAM_SIZES)[number];
export const DEFAULT_TEAMS: TeamSize = 5;
/**
 * Trials a venue runs: night 1, night 0 (seeding the true notes), another
 * pub's night 1 (writing the wrong notes), and night 2 four ways: its own
 * notes, none, another pub's, and the true ones. A run of one venue has no
 * other pub, so it runs two fewer.
 */
export const TRIALS_PER_VENUE = 7;
/**
 * An estimate, in US dollars, of one trial's model cost: Sonnet 5.5 at list
 * price, measured at $0.086 over 66 six-round trials on 2026-11-24. Team size
 * barely moves it.
 */
export const COST_PER_TRIAL = 0.086;

export const isTeamSize = (value: unknown): value is TeamSize =>
  (TEAM_SIZES as readonly unknown[]).includes(value);

/** A venue's Harbor task for a night and crowd size, such as night1-leeds or night2-leeds-t8. */
export const taskName = (
  night: 0 | 1 | 2,
  slug: string,
  teams: TeamSize = DEFAULT_TEAMS,
) => `night${night}-${slug}${teams === DEFAULT_TEAMS ? "" : `-t${teams}`}`;
const NOTES_PREVIEW = 600;

/**
 * The pub whose notes venue i's wrong-notes night 2 loads: the next pub in the
 * list in another country with none of its favourites, else the next in
 * another country, else the next; null when there is no other pub.
 */
export function donorOf(
  index: number,
  venues: { region: string; liked?: string[] }[],
): number | null {
  const n = venues.length;
  if (n < 2) return null;
  const me = venues[index];
  const others = Array.from({ length: n - 1 }, (_, k) => (index + k + 1) % n);
  const abroad = others.filter((j) => venues[j].region !== me.region);
  const unlike = abroad.filter(
    (j) => !(venues[j].liked ?? []).some((g) => me.liked?.includes(g)),
  );
  return unlike[0] ?? abroad[0] ?? others[0];
}

/**
 * The chains of a run, all started at once; a chain runs its steps in order,
 * and a step with `after` waits for those steps too. Per venue: night 1 then
 * night 2 on one identity (its own notes); night 2 on a fresh identity (none);
 * night 0 then night 2 on a third (the true notes); and another pub's night 1
 * then this venue's night 2 on a fourth (wrong notes), so each placebo loads a
 * fresh night-1 notes file of its own, shared with no other trial. Venue i plays profile i,
 * cycling when there are more venues than profiles, to a crowd of `teams`.
 */
export function plan(
  run: string,
  venues: number,
  profiles: VenueProfile[] = VENUES,
  teams: TeamSize = DEFAULT_TEAMS,
): Step[][] {
  const count = Math.min(
    Math.max(Math.trunc(venues) || 1, 1),
    Math.max(profiles.length, MAX_VENUES),
  );
  const planned = Array.from({ length: count }, (_, index) => {
    const profile = profiles[index % profiles.length];
    const lap = Math.floor(index / profiles.length);
    return {
      profile,
      venue: lap ? `${profile.slug}-${lap + 1}` : profile.slug,
      venue_label: lap ? `${profile.label} #${lap + 1}` : profile.label,
      identity: `anon:sim-${run}-${lap ? `${profile.slug}-${lap + 1}` : profile.slug}`,
    };
  });
  const chains: Step[][] = [];
  for (const { profile, venue, venue_label, identity } of planned) {
    const base = { run, venue, venue_label };
    const night2 = taskName(2, profile.slug, teams);
    chains.push(
      [
        {
          ...base,
          night: "night1-memory",
          task: taskName(1, profile.slug, teams),
          identity,
        },
        {
          ...base,
          night: "night2-hosted",
          task: night2,
          identity,
          variant: "with",
        },
      ],
      [
        {
          ...base,
          night: "night2-fresh",
          task: night2,
          identity: `${identity}-fresh`,
          variant: "without",
        },
      ],
      [
        {
          ...base,
          night: "night0-seed",
          task: taskName(0, profile.slug),
          identity: `${identity}-perfect`,
        },
        {
          ...base,
          night: "night2-perfect",
          task: night2,
          identity: `${identity}-perfect`,
          variant: "perfect",
        },
      ],
    );
  }
  planned.forEach(({ profile, venue, venue_label, identity }, index) => {
    const donor = donorOf(
      index,
      planned.map((p) => p.profile),
    );
    if (donor === null) return;
    const from = planned[donor];
    const base = {
      run,
      venue,
      venue_label,
      identity: `${identity}-wrong`,
      donor: from.venue,
      donor_label: from.venue_label,
    };
    chains.push([
      {
        ...base,
        night: "night1-donor",
        task: taskName(1, from.profile.slug, teams),
      },
      {
        ...base,
        night: "night2-wrong",
        task: taskName(2, profile.slug, teams),
        variant: "wrong",
      },
    ]);
  });
  return chains;
}

/** Tags every trial so a member who holds it can read them; an owner adds it to a member. */
export const TRIALS_TAG = "simulation:trivia-night";
export const runTag = (run: string) => `simulation:${run}`;

export interface TeamMark {
  team: string;
  correct: boolean;
}

export interface PlayedQuestion {
  text: string | null;
  options?: string[];
  answer: string | null;
  marks: TeamMark[];
}

export interface PlayedRound {
  round: number;
  genre: string;
  difficulty: number;
  /** Share of the crowd's answers marked right; null when nothing was marked. */
  correct_rate: number | null;
  questions: PlayedQuestion[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const textOrNull = (v: unknown) => (typeof v === "string" ? v : null);

/** The verifier's `rounds`, keeping only well-formed rounds and questions. */
export function parseRounds(value: unknown): PlayedRound[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((r, i) => ({
    round: typeof r.round === "number" ? r.round : i + 1,
    genre: typeof r.genre === "string" ? r.genre : "",
    difficulty: typeof r.difficulty === "number" ? r.difficulty : 0,
    correct_rate: typeof r.correct_rate === "number" ? r.correct_rate : null,
    questions: (Array.isArray(r.questions) ? r.questions : [])
      .filter(isRecord)
      .map((q) => ({
        text: textOrNull(q.text),
        ...(Array.isArray(q.options)
          ? {
              options: q.options.filter(
                (o): o is string => typeof o === "string",
              ),
            }
          : {}),
        answer: textOrNull(q.answer),
        marks: (Array.isArray(q.marks) ? q.marks : [])
          .filter(isRecord)
          .filter((m) => typeof m.team === "string")
          .map((m) => ({
            team: m.team as string,
            correct: m.correct === true,
          })),
      })),
  }));
}

/**
 * What a run was started with. Every trial task carries it in its metadata,
 * so the run is exactly its tasks: listing them by `runTag` rebuilds it, and
 * the trials still to create are the plan's steps no task names yet.
 */
export interface RunRecord {
  run: string;
  venues: number;
  teams: TeamSize;
  pubs: Pubs;
  /** The signed-in member who started the run, by id. */
  started_by: string;
  started_at: string;
  target: Target;
}

/** The task metadata key a trial records itself under. */
export const TRIAL_METADATA_KEY = "trivia_night";

export interface TrialMeta {
  /** The step's `stepKey`. */
  step: string;
  record: RunRecord;
}

/** A task's trial record, or null for a task this page did not create. */
export function trialMeta(
  metadata: Record<string, unknown> | null | undefined,
): TrialMeta | null {
  const value = metadata?.[TRIAL_METADATA_KEY];
  if (!isRecord(value) || typeof value.step !== "string") return null;
  const record = value.record;
  if (
    !isRecord(record) ||
    typeof record.run !== "string" ||
    typeof record.venues !== "number" ||
    !isTeamSize(record.teams) ||
    !isPubs(record.pubs) ||
    !isRecord(record.target)
  )
    return null;
  return value as unknown as TrialMeta;
}

/** Every step of a recorded run, in plan order, each after the one before it in its chain. */
export function runSteps(record: RunRecord): Step[] {
  return plan(
    record.run,
    record.venues,
    PUB_SETS[record.pubs],
    record.teams,
  ).flatMap((chain) =>
    chain.map((step, index) => ({
      ...step,
      ...(index ? { after: [stepKey(chain[index - 1])] } : {}),
      started_by: record.started_by,
    })),
  );
}

const TASK_ENDED = new Set(["completed", "failed", "cancelled"]);

/** The parts of a task a trial's state is read from. */
export interface TrialTask {
  status: string;
  metadata?: Record<string, unknown> | null;
}

/** The task's `metadata.verification`, which the platform writes once its verifier has run, or null. */
export function trialVerification(
  metadata: Record<string, unknown> | null | undefined,
): TaskVerification | null {
  const value = metadata?.verification;
  return isRecord(value) && typeof value.completed_at === "string"
    ? (value as unknown as TaskVerification)
    : null;
}

export interface TrialState {
  /** The task has ended, so nothing more will happen to its result or its notes. */
  done: boolean;
  failed: boolean;
  error: string | null;
}

/** Scored once the task has ended `completed` with a verification that reports no error. */
export function trialState(task: TrialTask): TrialState {
  if (!TASK_ENDED.has(task.status))
    return { done: false, failed: false, error: null };
  const verification = trialVerification(task.metadata);
  const reason = task.metadata?.error;
  const error =
    task.status !== "completed"
      ? typeof reason === "string" && reason
        ? reason
        : `the trial was ${task.status} before it was scored`
      : !verification
        ? "the trial ended without its verifier running"
        : verification.error
          ? verification.error
          : verification.exit_code
            ? `the verifier exited ${verification.exit_code}`
            : null;
  return { done: true, failed: error !== null, error };
}

/** A step the page shows: its task's state, or why it has none yet. */
export interface TrialView {
  key: string;
  step: Step;
  task_id: string | null;
  status: string;
  /** Whether its verifier has recorded an outcome. */
  scored: boolean;
  done: boolean;
  /** A finished trial's result to read from its task, or the skipped step's record. */
  finished: EvalFinished | null;
}

export interface RunView {
  run: string;
  record: RunRecord;
  trials: TrialView[];
  finished: EvalRunFinished | null;
  /** The trials own no memory, as a business member's eval tasks do not yet, so night 2 runs without notes. */
  memory_off: boolean;
}

/** A night that never ran because a night it depends on failed, so it is never scored. */
export function skippedTrial(step: Step, reason: string): EvalFinished {
  return {
    ...step,
    reward: null,
    checks: {},
    notes: null,
    fetches: [],
    rounds: [],
    measures: {},
    seconds: 0,
    exit_code: null,
    error: reason,
  };
}

export interface TrialResult {
  reward: number | null;
  checks: Record<string, number>;
  /** The whole MEMORY.md; previewNotes() cuts it for the feed. */
  notes: string | null;
  /** Night 2's `next_questions` calls, as its verifier printed them. */
  fetches: Fetch[];
  rounds: PlayedRound[];
  steps: TrialEvent[];
  steps_error: string | null;
  /** The crowd's true tastes, which the verifier keeps beside its result. */
  tastes: VenueTastes | null;
}

/** The verifier prints one JSON object: the reward, each check, and context. */
export function parseVerifierJson(
  text: string | null,
): Record<string, unknown> | null {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * A trial's result from its verification files: the log is what the verifier
 * printed, with every measure, its rounds, the notes, the host's steps and
 * the crowd's tastes; the result file holds the reward and the checks, and
 * stands in when the log has no JSON.
 */
export function verifierOutput(
  log: string | null,
  result: string | null,
  reward: number | null = null,
): TrialResult {
  const printed = parseVerifierJson(log) ?? parseVerifierJson(result) ?? {};
  const checks: Record<string, number> = {};
  for (const [name, value] of Object.entries(printed))
    if (name !== "reward" && typeof value === "number") checks[name] = value;
  const notes =
    typeof printed.notes === "string" && printed.notes.trim()
      ? printed.notes.trim()
      : null;
  return {
    reward:
      reward ?? (typeof printed.reward === "number" ? printed.reward : null),
    checks,
    notes,
    fetches: Array.isArray(printed.fetches) ? (printed.fetches as Fetch[]) : [],
    rounds: parseRounds(printed.rounds),
    steps: hostEvents(printed.steps, printed.plan),
    steps_error:
      typeof printed.steps_error === "string" ? printed.steps_error : null,
    tastes: isRecord(printed.tastes)
      ? (printed.tastes as unknown as VenueTastes)
      : null,
  };
}

export function previewNotes(notes: string | null): string | null {
  return notes ? notes.slice(0, NOTES_PREVIEW) : null;
}
