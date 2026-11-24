/**
 * Runs the memory evals on the platform from the page: one chain per venue,
 * all at once, each step a `introspection eval run` child whose result goes on
 * the events feed. Server only.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { record } from "./events";
import { measuresOf } from "./memory-measures";
import {
  errorText,
  findRunFolder,
  newRunId,
  plan,
  previewNotes,
  readRunFolder,
  readTastes,
  runsRoot,
  spawnSpec,
  type EvalFinished,
  type EvalRunFinished,
  type EvalStarted,
  type Step,
  type Target,
} from "./platform-evals";
import {
  parseTaskId,
  StreamMapper,
  streamSpec,
  tagged,
  trajectoryEvents,
  trajectoryFile,
  type TrialEvent,
} from "./trial-stream";

const DEFAULT_API_BASE_URL = "https://api.introspection.dev";
const run = promisify(execFile);
const RUNTIME_SLUG = "trivia-host";
/** How soon a stream that ended before its run did is reattached. */
const REATTACH_MS = 3000;
/** How long a stream may run on once its trial has finished. */
const STREAM_GRACE_MS = 15_000;

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

/** One trial's agent work on the events feed, each event once. */
function trialFeed(step: Step) {
  const shown = new Set<string>();
  return (taskId: string, events: TrialEvent[]) => {
    for (const event of events) {
      if (shown.has(event.key)) continue;
      shown.add(event.key);
      record(
        `platform:${step.run}:${step.venue}`,
        event.type,
        event.summary,
        tagged(step, taskId, event),
      );
    }
  };
}

/**
 * Follows a trial's task with `introspection tasks stream`, reattaching from
 * the cursor when a stream ends before its run does (a task still queued has
 * no run to attach to yet). Resolves once the run ended on the stream, or the
 * attach running when `settle` is called ends, or `stop` kills it.
 */
function follow(
  taskId: string,
  credentials: Credentials,
  emit: (events: TrialEvent[]) => void,
): { done: Promise<void>; settle: () => void; stop: () => void } {
  const mapper = new StreamMapper();
  let settled = false;
  let child: ReturnType<typeof spawn> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: () => void = () => {};
  const attach = () =>
    new Promise<void>((resolve) => {
      const spec = streamSpec(taskId, recipeDir(), credentials, {
        runId: mapper.runId,
        since: mapper.cursor,
      });
      child = spawn(spec.command, spec.args, {
        ...spec.options,
        env: spec.options.env as NodeJS.ProcessEnv,
      });
      let pending = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        pending += chunk.toString();
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) emit(mapper.push(line));
      });
      // Its errors name the task and the cursor only; the trajectory fills any gap.
      child.stderr?.resume();
      child.on("error", () => resolve());
      child.on("close", () => {
        emit(mapper.push(pending));
        resolve();
      });
    });
  const done = (async () => {
    while (!settled) {
      await attach();
      if (settled || mapper.ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, REATTACH_MS);
      });
    }
  })();
  const settle = () => {
    settled = true;
    clearTimeout(timer);
    wake();
  };
  return {
    done,
    settle,
    stop: () => {
      settle();
      child?.kill();
    },
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
  const emit = trialFeed(step);
  const began = Date.now();
  let taskId: string | null = null;
  let stream: ReturnType<typeof follow> | null = null;
  return new Promise((resolve) => {
    let output = "";
    let done = false;
    const finish = async (exitCode: number | null, failure?: string) => {
      // A spawn failure can be followed by `close` as well.
      if (done) return;
      done = true;
      if (stream) {
        const current = stream;
        current.settle();
        const grace = setTimeout(current.stop, STREAM_GRACE_MS);
        await current.done;
        clearTimeout(grace);
        current.stop();
      }
      const seconds = Math.round((Date.now() - began) / 1000);
      const folder = findRunFolder(output, runsRoot(recipeDir(), step));
      let trial: ReturnType<typeof readRunFolder> | null = null;
      let readError: string | null = null;
      if (folder) {
        try {
          trial = readRunFolder(folder);
        } catch (error) {
          readError = `could not read ${folder}: ${(error as Error).message}`;
        }
        // Whatever the stream missed, from the finished trial's record.
        const trajectory = trajectoryFile(folder);
        if (trajectory) {
          try {
            emit(taskId ?? "", trajectoryEvents(trajectory));
          } catch (error) {
            readError ??= `could not read ${trajectory}: ${(error as Error).message}`;
          }
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
      if (taskId) return;
      taskId = parseTaskId(output);
      if (taskId) {
        const id = taskId;
        stream = follow(id, credentials, (events) => emit(id, events));
      }
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
  const chains = plan(id, venues);
  const began = Date.now();
  void Promise.all(
    chains.map(async (chain) => {
      let notes: string | null = null;
      for (const step of chain)
        notes = await runStep(step, target, { token, apiBaseUrl: api }, notes);
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
