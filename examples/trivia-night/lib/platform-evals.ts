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

export type Night = "night1-memory" | "night2-hosted" | "night2-control";

export interface Target {
  runtime: string;
  commit: string;
}

export type Step = {
  run: string;
  venue: string;
  night: Night;
  identity: string;
};

export type EvalStarted = Step;

export type EvalFinished = Step & {
  reward: number | null;
  checks: Record<string, number>;
  notes: string | null;
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

export const MAX_VENUES = 8;
const NOTES_PREVIEW = 600;

export function newRunId(now = new Date()): string {
  return `r${now.getTime()}`;
}

export function venueLabel(index: number): string {
  return `venue-${String.fromCharCode(97 + index)}`;
}

/** One chain per venue (night 1, then night 2 on the same identity), and one control. */
export function plan(run: string, venues: number): Step[][] {
  const count = Math.min(Math.max(Math.trunc(venues) || 1, 1), MAX_VENUES);
  const chains: Step[][] = [];
  for (let index = 0; index < count; index += 1) {
    const venue = venueLabel(index);
    const identity = `anon:sim-${run}-${venue}`;
    chains.push([
      { run, venue, night: "night1-memory", identity },
      { run, venue, night: "night2-hosted", identity },
    ]);
  }
  chains.push([
    {
      run,
      venue: "control",
      night: "night2-control",
      identity: `anon:sim-${run}-control`,
    },
  ]);
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
    `evals/harbor/${step.night}`,
    "--identity",
    step.identity,
    "--tag",
    `simulation:${step.run}`,
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

export interface TrialResult {
  reward: number | null;
  checks: Record<string, number>;
  notes: string | null;
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
    notes: notes ? notes.trim().slice(0, NOTES_PREVIEW) : null,
    trajectory_source: typeof source === "string" ? source : null,
    error: error ? error.trim() : null,
  };
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
