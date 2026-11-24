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
import {
  errorText,
  findRunFolder,
  newRunId,
  plan,
  readRunFolder,
  runsRoot,
  spawnSpec,
  type EvalFinished,
  type EvalRunFinished,
  type EvalStarted,
  type Step,
  type Target,
} from "./platform-evals";

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

/**
 * The page is also served on a public tunnel. Only a browser on this machine
 * may spend the key, so a proxied or cross-origin request is refused.
 */
export function notLocal(request: Request): string | null {
  const headers = request.headers;
  if (headers.has("cf-connecting-ip") || headers.has("cf-ray"))
    return "only a browser on this machine can run the evals";
  const host = (headers.get("host") ?? new URL(request.url).host).replace(
    /:\d+$/,
    "",
  );
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host))
    return "only a browser on this machine can run the evals";
  const origin = headers.get("origin");
  if (
    origin &&
    !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)
  )
    return "cross-origin requests are refused";
  return null;
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
  if (runtime && commit) return { runtime, commit };
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
  return { runtime: runtime ?? latest.id, commit: sha };
}

async function resolveDpUrl(env: NodeJS.ProcessEnv): Promise<string> {
  const named = env.INTROSPECTION_DP_URL?.trim();
  if (named) return named;
  const { stdout } = await run(
    "introspection",
    ["whoami", "--query", "dp_url", "-o", "table"],
    { env },
  );
  const url = stdout.trim();
  if (!url) throw new Error("set INTROSPECTION_DP_URL in .env.local");
  return url;
}

export function activeRun(): string | null {
  return platform.active;
}

function runStep(
  step: Step,
  target: Target,
  credentials: { token: string; dpUrl: string },
): Promise<void> {
  const started: EvalStarted = { ...step };
  record(
    `platform:${step.run}`,
    "eval.started",
    `${step.venue} ${step.night} as ${step.identity}`,
    started,
  );
  const spec = spawnSpec(step, target, recipeDir(), credentials);
  const began = Date.now();
  return new Promise((resolve) => {
    let output = "";
    let done = false;
    const finish = (exitCode: number | null, failure?: string) => {
      // A spawn failure can be followed by `close` as well.
      if (done) return;
      done = true;
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
      }
      const error =
        failure ??
        trial?.error ??
        readError ??
        (exitCode === 0 ? null : errorText(output, credentials.token));
      const finished: EvalFinished = {
        ...step,
        reward: trial?.reward ?? null,
        checks: trial?.checks ?? {},
        notes: trial?.notes ?? null,
        trajectory_source: trial?.trajectory_source ?? null,
        seconds,
        exit_code: exitCode,
        error: error ? errorText(error, credentials.token) : null,
      };
      record(
        `platform:${step.run}`,
        "eval.finished",
        `${step.venue} ${step.night}: reward ${finished.reward ?? "none"} in ${seconds}s`,
        finished,
      );
      resolve();
    };
    const child = spawn(spec.command, spec.args, {
      ...spec.options,
      env: spec.options.env as NodeJS.ProcessEnv,
    });
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code));
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
  let target: Target;
  let dpUrl: string;
  try {
    target = await resolveTarget();
    dpUrl = await resolveDpUrl(process.env);
  } catch (error) {
    platform.active = null;
    throw error;
  }
  const chains = plan(id, venues);
  const began = Date.now();
  void Promise.all(
    chains.map(async (chain) => {
      for (const step of chain) await runStep(step, target, { token, dpUrl });
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
