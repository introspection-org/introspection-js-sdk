/**
 * Runs the memory evals on the platform from the page: one chain per venue,
 * all at once, each step a `introspection eval run` child whose result goes on
 * the events feed. Server only.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { record } from "./events";
import { judgeInput, judgeSpec, parseJudgement, type Judgement } from "./judge";
import { measuresOf } from "./memory-measures";
import {
  DEFAULT_TEAMS,
  errorText,
  findRunFolder,
  newRunId,
  PUB_SETS,
  plan,
  planText,
  previewNotes,
  readRunFolder,
  readTastes,
  runsRoot,
  spawnSpec,
  stepKey,
  type EvalFinished,
  type EvalRunFinished,
  type EvalStarted,
  type Pubs,
  type Step,
  type Target,
  type TeamSize,
} from "./platform-evals";
import {
  tagged,
  trajectoryEvents,
  trajectoryFile,
  type TrialEvent,
} from "./trial-steps";

const DEFAULT_API_BASE_URL = "https://api.introspection.dev";
const run = promisify(execFile);
const RUNTIME_SLUG = "trivia-host";

export const KEY_HOW_TO = [
  "introspection api-keys create --environment staging --capabilities runtimes,evals \\",
  "  --expires-at <today, 23:59 UTC> --secret-file recipe-operator/.agent.key",
  "echo TRIVIA_EVAL_KEY_FILE=recipe-operator/.agent.key >> .env.local",
].join("\n");

const store = globalThis as unknown as {
  __triviaPlatform?: { active: string | null };
};
const platform = (store.__triviaPlatform ??= { active: null });

export function recipeDir(): string {
  return path.join(process.cwd(), "recipe-operator");
}

/** The configured key file, or why there is none. Never reads the key itself. */
export function keyFile(
  env: NodeJS.ProcessEnv = process.env,
): { file: string } | { missing: string } {
  const named = env.TRIVIA_EVAL_KEY_FILE?.trim();
  if (!named) return { missing: "TRIVIA_EVAL_KEY_FILE is not set" };
  const file = path.resolve(process.cwd(), named);
  if (!existsSync(file)) return { missing: `${named} does not exist` };
  return { file };
}

interface RuntimeRecord {
  id: string;
  slug: string;
  git_commit_sha?: string | null;
  created_at?: string;
}

export async function resolveTarget(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Target> {
  const runtime = env.INTROSPECTION_TRIVIA_RUNTIME_ID?.trim();
  const commit = env.INTROSPECTION_TRIVIA_COMMIT_SHA?.trim();
  if (runtime && commit) return { runtime, commit, slug: RUNTIME_SLUG };
  const { stdout } = await run(
    "introspection",
    ["runtimes", "list", "-o", "json"],
    {
      env,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const parsed = JSON.parse(stdout) as
    RuntimeRecord[] | { records: RuntimeRecord[] };
  const latest = (Array.isArray(parsed) ? parsed : parsed.records)
    .filter((item) => item.slug === RUNTIME_SLUG)
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))[0];
  if (!latest)
    throw new Error(
      `no ${RUNTIME_SLUG} runtime in this project: run pnpm dev first`,
    );
  const sha = commit ?? latest.git_commit_sha;
  if (!sha) throw new Error(`the ${RUNTIME_SLUG} runtime has no commit yet`);
  return { runtime: runtime ?? latest.id, commit: sha, slug: RUNTIME_SLUG };
}

/** The Control Plane the CLI talks to; it finds the Data Plane from there. */
export function apiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.INTROSPECTION_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL;
}

export function activeRun(): string | null {
  return platform.active;
}

type Credentials = { token: string; apiBaseUrl: string };

/** A finished trial's steps on the events feed; returns its last message. */
function recordSteps(step: Step, events: TrialEvent[]): string | null {
  let planned: string | null = null;
  for (const event of events) {
    if (event.type === "host.planned" && typeof event.data.file === "string")
      planned = event.data.file;
    record(
      `platform:${step.run}:${step.venue}`,
      event.type,
      event.summary,
      tagged(step, event),
    );
  }
  return planned;
}

/** Grades a finished night 2 with the return-visit judge, from its local trajectory. */
async function judge(
  step: Step,
  folder: string,
  trajectory: string,
): Promise<Judgement> {
  const customId = `${step.venue}-${step.night}`;
  const dir = path.join(folder, "judge");
  mkdirSync(dir, { recursive: true });
  const input = path.join(dir, "input.jsonl");
  writeFileSync(
    input,
    `${JSON.stringify(judgeInput(customId, JSON.parse(readFileSync(trajectory, "utf8"))))}\n`,
  );
  const spec = judgeSpec(input, dir, recipeDir());
  const output = await new Promise<string>((resolve) => {
    let text = "";
    const child = spawn(spec.command, spec.args, {
      ...spec.options,
      env: spec.options.env as NodeJS.ProcessEnv,
    });
    child.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (text += chunk.toString()));
    child.on("error", (error) => resolve(error.message));
    child.on("close", () => resolve(text));
  });
  const results = path.join(dir, "results.jsonl");
  const found = existsSync(results)
    ? parseJudgement(readFileSync(results, "utf8"), customId)
    : null;
  if (found) return found;
  const hint = process.env.ANTHROPIC_API_KEY
    ? ""
    : " (the judge's model needs ANTHROPIC_API_KEY or a Pi sign-in)";
  return {
    score: null,
    reason: null,
    error: `${output.trim().split("\n").pop() || "the judge wrote no result"}${hint}`,
  };
}

/** Runs one step; resolves with the notes it left, for the chain's next night. */
function runStep(
  step: Step,
  target: Target,
  credentials: Credentials,
  night1Notes: string | null = null,
): Promise<string | null> {
  const started: EvalStarted = { ...step };
  record(
    `platform:${step.run}:${step.venue}`,
    "eval.started",
    `${step.venue_label} ${step.task} as ${step.identity}`,
    started,
  );
  const spec = spawnSpec(step, target, recipeDir(), credentials);
  const began = Date.now();
  return new Promise((resolve) => {
    let output = "";
    let done = false;
    const finish = async (exitCode: number | null, failure?: string) => {
      // A spawn failure can be followed by `close` as well.
      if (done) return;
      done = true;
      const seconds = Math.round((Date.now() - began) / 1000);
      const folder = findRunFolder(output, runsRoot(recipeDir(), step));
      let trial: ReturnType<typeof readRunFolder> | null = null;
      let readError: string | null = null;
      let planned: string | null = null;
      let judgement: Judgement | null = null;
      if (folder) {
        try {
          trial = readRunFolder(folder);
        } catch (error) {
          readError = `could not read ${folder}: ${(error as Error).message}`;
        }
        const trajectory = trajectoryFile(folder);
        if (trajectory) {
          try {
            planned = recordSteps(step, trajectoryEvents(trajectory));
          } catch (error) {
            readError ??= `could not read ${trajectory}: ${(error as Error).message}`;
          }
          if (step.night.startsWith("night2"))
            judgement = await judge(step, folder, trajectory).catch(
              (error: Error) => ({
                score: null,
                reason: null,
                error: error.message,
              }),
            );
        }
      }
      const error =
        failure ??
        trial?.error ??
        readError ??
        (exitCode === 0 ? null : errorText(output, credentials.token));
      const checks = trial?.checks ?? {};
      const finished: EvalFinished = {
        ...step,
        reward: trial?.reward ?? null,
        checks,
        notes: previewNotes(trial?.notes ?? null),
        plan: planText(planned),
        round: trial?.fetches[0] ?? null,
        fetches: trial?.fetches ?? [],
        judge: judgement,
        measures: trial
          ? measuresOf(step.night, {
              checks,
              notes: trial.notes,
              fetches: trial.fetches,
              tastes: readTastes(recipeDir(), step.task),
              night1Notes,
            })
          : {},
        trajectory_source: trial?.trajectory_source ?? null,
        seconds,
        exit_code: exitCode,
        error: error ? errorText(error, credentials.token) : null,
      };
      record(
        `platform:${step.run}:${step.venue}`,
        "eval.finished",
        `${step.venue_label} ${step.task}: reward ${finished.reward ?? "none"} in ${seconds}s`,
        finished,
      );
      resolve(trial?.notes ?? null);
    };
    const child = spawn(spec.command, spec.args, {
      ...spec.options,
      env: spec.options.env as NodeJS.ProcessEnv,
    });
    const read = (chunk: Buffer) => {
      output += chunk.toString();
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", (error) => void finish(null, error.message));
    child.on("close", (code) => void finish(code));
  });
}

/** Starts a run and returns its id; the trials report on the events feed. */
export async function startRun(
  venues: number,
  teams: TeamSize = DEFAULT_TEAMS,
  pubs: Pubs = "development",
): Promise<{ run: string; target: Target }> {
  if (platform.active) throw new Error(`run ${platform.active} is still going`);
  const found = keyFile();
  if ("missing" in found) throw new Error(found.missing);
  const token = readFileSync(found.file, "utf8").trim();
  if (!token) throw new Error("the key file is empty");
  const id = newRunId();
  platform.active = id;
  const api = apiBaseUrl();
  let target: Target;
  try {
    target = await resolveTarget({
      ...process.env,
      INTROSPECTION_API_BASE_URL: api,
    });
  } catch (error) {
    platform.active = null;
    throw error;
  }
  const chains = plan(id, venues, PUB_SETS[pubs], teams);
  const began = Date.now();
  // Each step's notes once it finishes, for the steps that wait on it.
  const settled = new Map<string, Promise<string | null>>();
  const finishers = new Map<string, (notes: string | null) => void>();
  for (const step of chains.flat())
    settled.set(
      stepKey(step),
      new Promise((resolve) => finishers.set(stepKey(step), resolve)),
    );
  void Promise.all(
    chains.map(async (chain) => {
      let notes: string | null = null;
      for (const step of chain) {
        if (step.after?.length)
          [notes] = await Promise.all(
            step.after.map((key) => settled.get(key) ?? null),
          );
        notes = await runStep(step, target, { token, apiBaseUrl: api }, notes);
        finishers.get(stepKey(step))?.(notes);
      }
    }),
  ).finally(() => {
    const finished: EvalRunFinished = {
      run: id,
      seconds: Math.round((Date.now() - began) / 1000),
      trials: chains.flat().length,
    };
    record(
      `platform:${id}`,
      "eval.run_finished",
      `run ${id} finished in ${finished.seconds}s`,
      finished,
    );
    platform.active = null;
  });
  return { run: id, target };
}
