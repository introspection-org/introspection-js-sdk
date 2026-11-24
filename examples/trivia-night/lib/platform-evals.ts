/**
 * The memory evals as cloud trials of the deployed `trivia-host` Runtime: what
 * each `introspection eval run` is called with, and what its run folder says.
 * The spawning lives in platform-runner.ts; everything here is pure or reads files.
 */
import type {
  SpawnOptionsWithStdioTuple,
  StdioNull,
  StdioPipe,
} from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import HELDOUT from "../recipe-operator/evals/heldout.json";
import VENUES from "../recipe-operator/evals/venues.json";
import { plainText, truncateWords } from "./display";
import type { Judgement } from "./judge";
import type { Fetch, Measures, VenueTastes } from "./memory-measures";

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
 * another pub's customer, so it loads that pub's notes; `night0-seed` writes
 * the venue's true notes for `night2-perfect`.
 */
export type Night =
  | "night0-seed"
  | "night1-memory"
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
  /**
   * Steps (`stepKey`) this one waits for; the first's notes are its night-1
   * notes. A wrong-notes night 2 waits for its donor's night 1 and night 2,
   * so neither of the donor's reads sees its writes.
   */
  after?: string[];
  /** The pub whose customer a wrong-notes night 2 runs as. */
  donor?: string;
  donor_label?: string;
};

export const stepKey = (step: { venue: string; night: string }) =>
  `${step.venue}/${step.night}`;

export type EvalStarted = Step;

export type EvalFinished = Step & {
  reward: number | null;
  checks: Record<string, number>;
  notes: string | null;
  /** The agent's last message, as plain text. */
  plan?: string | null;
  /** The first round it fetched, from the verifier. */
  round?: Fetch | null;
  /** The return-visit judge's grade of a night 2. */
  judge?: Judgement | null;
  /** Absent on trials recorded before measures existed. */
  measures?: Measures;
  /** Each round it fetched, from the verifier. */
  fetches?: Fetch[];
  /** Each round as played: its questions, their answers and each team's mark. */
  rounds?: PlayedRound[];
  trajectory_source: string | null;
  seconds: number;
  exit_code: number | null;
  error: string | null;
};

export type EvalRunFinished = {
  run: string;
  seconds: number;
  trials: number;
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
 * Trials a venue runs: night 1, night 0 (seeding the true notes), and night 2
 * four ways: its own notes, none, another pub's, and the true ones. A run of
 * one venue has no other pub's notes, so it runs one fewer.
 */
export const TRIALS_PER_VENUE = 6;
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
const PLAN_PREVIEW = 300;

export function newRunId(now = new Date()): string {
  return `r${now.getTime()}`;
}

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
 * night 0 then night 2 on a third (the true notes); and, after every venue's,
 * night 2 as another pub's customer (wrong notes). Venue i plays profile i,
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
  planned.forEach(({ profile, venue, venue_label }, index) => {
    const donor = donorOf(
      index,
      planned.map((p) => p.profile),
    );
    if (donor === null) return;
    const from = planned[donor];
    chains.push([
      {
        run,
        venue,
        venue_label,
        night: "night2-wrong",
        task: taskName(2, profile.slug, teams),
        identity: from.identity,
        variant: "wrong",
        after: [
          stepKey({ venue: from.venue, night: "night1-memory" }),
          stepKey({ venue: from.venue, night: "night2-hosted" }),
        ],
        donor: from.venue,
        donor_label: from.venue_label,
      },
    ]);
  });
  return chains;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  options: Omit<
    SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>,
    "env"
  > & {
    cwd: string;
    env: Record<string, string | undefined>;
    shell: false;
  };
}

/** Tags every trial so a member who holds it can read them; an owner adds it to a member. */
export const TRIALS_TAG = "simulation:trivia-night";

/**
 * The child's command line and environment. The key travels only as
 * INTROSPECTION_TOKEN; each step gets its own runs root, so concurrent runs
 * never share a folder.
 */
export function spawnSpec(
  step: Step,
  target: Target,
  recipeDir: string,
  credentials: { token: string; apiBaseUrl: string },
  baseEnv: Record<string, string | undefined> = process.env,
): SpawnSpec {
  const args = [
    "eval",
    "run",
    "-r",
    target.runtime,
    "--commit-sha",
    target.commit,
    // Resolved inside the runtime's Recipe at --commit-sha, so it is relative.
    "--path",
    `evals/harbor/${step.task}`,
    "--identity",
    step.identity,
    "--tag",
    `simulation:${step.run}`,
    // A stable tag on every run's trials: a member given it can read them all.
    "--tag",
    TRIALS_TAG,
    "-y",
  ];
  return {
    command: "introspection",
    args,
    options: {
      cwd: recipeDir,
      env: {
        ...baseEnv,
        INTROSPECTION_TOKEN: credentials.token,
        INTROSPECTION_API_BASE_URL: credentials.apiBaseUrl,
        INTROSPECTION_EVAL_RUNS_DIR: runsRoot(recipeDir, step),
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  };
}

export function runsRoot(recipeDir: string, step: Step): string {
  return path.join(
    recipeDir,
    "eval-runs",
    step.run,
    `${step.venue}-${step.night}`,
  );
}

/**
 * The run folder of one finished `eval run`: the `Results` line it printed, or
 * else the one folder with a run.json in the step's own runs root.
 */
export function findRunFolder(output: string, root: string): string | null {
  for (const match of output.matchAll(/^\s*Results\s+(\S.*?)\s*$/gm)) {
    const folder = match[1];
    if (existsSync(path.join(folder, "run.json"))) return folder;
  }
  if (!existsSync(root)) return null;
  const folders = readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((folder) => existsSync(path.join(folder, "run.json")))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return folders[0] ?? null;
}

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

export interface TrialResult {
  reward: number | null;
  checks: Record<string, number>;
  /** The whole MEMORY.md; previewNotes() cuts it for the feed. */
  notes: string | null;
  /** Night 2's `next_questions` calls, as its verifier printed them. */
  fetches: Fetch[];
  rounds: PlayedRound[];
  trajectory_source: string | null;
  error: string | null;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** The first value under `key` anywhere in a parsed JSON document. */
function findKey(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  if (!Array.isArray(value) && key in value)
    return (value as Record<string, unknown>)[key];
  for (const child of Object.values(value)) {
    const found = findKey(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The verifier prints one JSON object: the reward, each check, and context. */
function parseVerifierStdout(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

function trialFolder(runFolder: string): string | null {
  const harbor = path.join(runFolder, "harbor");
  if (!existsSync(harbor)) return null;
  const trial = readdirSync(harbor).find((name) => {
    const folder = path.join(harbor, name);
    return (
      statSync(folder).isDirectory() &&
      existsSync(path.join(folder, "result.json"))
    );
  });
  return trial ? path.join(harbor, trial) : null;
}

export function readRunFolder(runFolder: string): TrialResult {
  const run = readJson(path.join(runFolder, "run.json")) as {
    result?: {
      diagnostics?: { message?: string }[];
      metrics?: Record<string, number>;
    };
  };
  const trial = trialFolder(runFolder);
  const result = trial ? readJson(path.join(trial, "result.json")) : undefined;
  const stdoutFile = trial
    ? path.join(trial, "verifier", "test-stdout.txt")
    : null;
  const verifier =
    stdoutFile && existsSync(stdoutFile)
      ? parseVerifierStdout(readFileSync(stdoutFile, "utf8"))
      : null;
  const memoryFile = trial
    ? path.join(trial, "artifacts", "memories", "MEMORY.md")
    : null;

  const checks: Record<string, number> = {};
  for (const [name, value] of Object.entries(verifier ?? {}))
    if (name !== "reward" && typeof value === "number") checks[name] = value;

  const rewards = findKey(result, "rewards") as
    Record<string, unknown> | undefined;
  const reward =
    typeof verifier?.reward === "number"
      ? verifier.reward
      : typeof rewards?.reward === "number"
        ? rewards.reward
        : (run.result?.metrics?.reward ?? null);

  const notes =
    memoryFile && existsSync(memoryFile)
      ? readFileSync(memoryFile, "utf8")
      : typeof verifier?.notes === "string" && verifier.notes.trim()
        ? verifier.notes
        : null;

  const source =
    findKey(result, "trajectory_source") ?? findKey(run, "trajectory_source");
  const exception = findKey(result, "exception_message");
  const diagnostic = run.result?.diagnostics?.[0]?.message;
  const error =
    typeof exception === "string"
      ? exception
      : typeof diagnostic === "string"
        ? diagnostic
        : null;

  return {
    reward,
    checks,
    notes: notes ? notes.trim() : null,
    fetches: Array.isArray(verifier?.fetches)
      ? (verifier.fetches as Fetch[])
      : [],
    rounds: parseRounds(verifier?.rounds),
    trajectory_source: typeof source === "string" ? source : null,
    error: error ? error.trim() : null,
  };
}

/** The agent's message as plain text, cut to a preview. */
export function planText(message: string | null): string | null {
  const text = message ? plainText(message) : "";
  return text ? truncateWords(text, PLAN_PREVIEW) : null;
}

export function previewNotes(notes: string | null): string | null {
  return notes ? notes.slice(0, NOTES_PREVIEW) : null;
}

/** The venue's facts from its task's tests/expected.json, or null when it has none. */
export function readTastes(
  recipeDir: string,
  task: string,
): VenueTastes | null {
  const file = path.join(
    recipeDir,
    "evals",
    "harbor",
    task,
    "tests",
    "expected.json",
  );
  return existsSync(file) ? (readJson(file) as VenueTastes) : null;
}

/**
 * Why a run failed, with the key removed: from the CLI's last `Error:` line
 * on, which carries its hint (such as the setup command), else the output's
 * last lines.
 */
export function errorText(output: string, secret: string): string {
  const text = secret ? output.split(secret).join("[redacted]") : output;
  const lines = text.trim().split("\n");
  const last = lines.findLastIndex((line) => line.startsWith("Error:"));
  return (last >= 0 ? lines.slice(last) : lines.slice(-6)).join("\n").trim();
}
