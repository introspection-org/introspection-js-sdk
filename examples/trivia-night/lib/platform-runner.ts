/**
 * Runs the memory evals on the platform from the page, as plain calls through
 * the SDK with the signed-in member's own token: each trial is a `kind: eval`
 * task of the project's trivia Runtime that scores itself with its Harbor
 * task's own verifier, billed to the member's organization. Nothing is held
 * between calls: a run is its tasks, found by their tag, and `advanceRun`
 * moves it on from what they say. Runs in the browser (and under Node in the
 * tests), with web APIs only.
 */
import type {
  CreateTaskParams,
  IntrospectionApiClient,
  Task,
} from "@introspection-sdk/introspection-browser/api";
import { parse as parseYaml } from "yaml";

import { measuresOf, type VenueTastes } from "./memory-measures";
import {
  DEFAULT_TEAMS,
  PUB_SETS,
  taskName,
  previewNotes,
  runSteps,
  runTag,
  skippedTrial,
  stepKey,
  TRIAL_METADATA_KEY,
  TRIALS_TAG,
  trialMeta,
  trialState,
  trialVerification,
  runCancelled,
  untriedStep,
  verifierOutput,
  RUN_CANCELLED_KEY,
  type StepState,
  type EvalFinished,
  type Pubs,
  type RunRecord,
  type RunView,
  type Step,
  type Target,
  type TeamSize,
  type TrialMeta,
  type TrialView,
} from "./platform-evals";
import { loadedMemory } from "./trial-steps";

export type Env = Record<string, string | undefined>;

export const ADD_RUNTIME =
  "add the trivia-night runtime to your project: introspection runtimes create --manifest .introspection/trivia-night.yaml";
/** Where the Harbor tasks sit in the Recipe. */
const TASKS_DIR = "evals/harbor";
const MAIN_SERVICE = "main";
const MAIN_SERVICE_KEYS = new Set(["volumes", "depends_on"]);
/**
 * Harbor's verifier writes under /logs and reads /tests, both directly under
 * the root, which the sandbox user cannot write: as compose volumes they are
 * writable without privilege.
 */
const VERIFIER_VOLUMES: Record<string, string> = {
  "harbor-logs": "/logs",
  "harbor-tests": "/tests",
};
/** The uuid5 namespace a step's admission key is derived in. */
const ADMISSION_NAMESPACE = "6f1c2a8e-3b4d-5e6f-8a9b-0c1d2e3f4a5b";

/** What the run calls; the browser client, or the Node one in the tests and scripts. */
export type PlatformClient = Pick<
  IntrospectionApiClient,
  "tasks" | "files" | "images" | "repositories"
>;

const status = (error: unknown) => (error as { status?: number }).status;

/** The configured Runtime's commit carries no generated venue tasks. */
export class NoTasks extends Error {
  constructor(slug: string) {
    super(
      `the ${slug} runtime's commit carries no generated venue tasks (evals/harbor is git-ignored): push them with the recipe, as pnpm dev does, after ${ADD_RUNTIME.replace(/^add/, "adding")}`,
    );
  }
}

/** Whether a target's commit holds the generated tasks, by the first planned venue's night 1. */
export async function hasTasks(
  client: PlatformClient,
  target: Target,
): Promise<boolean> {
  const file = repoPath(
    target,
    TASKS_DIR,
    taskName(1, PUB_SETS.development[0].slug),
    "task.toml",
  );
  try {
    await client.repositories.contents.get(target.repository!, file, {
      ref: target.commit,
    });
    return true;
  } catch (error) {
    if (status(error) === 404) return false;
    throw error;
  }
}

/**
 * The Runtime the trials run, the commit they run at, and the repository that
 * holds its Recipe, as configured, once its commit is seen to hold the
 * generated venue tasks. The browser reaches only the Data Plane, so it cannot
 * look a Runtime up.
 */
export async function resolveTarget(
  client: PlatformClient,
  target: Target | null,
): Promise<Target> {
  if (!target)
    throw new Error(`no trivia Runtime is configured: ${ADD_RUNTIME}`);
  if (!(await hasTasks(client, target)))
    throw new NoTasks(target.slug ?? target.runtime);
  return target;
}

/** POSIX path helpers, so the browser needs no `node:path`. */
const posix = {
  normalize(file: string): string {
    const out: string[] = [];
    for (const part of file.split("/"))
      if (part === "..") {
        if (out.length && out[out.length - 1] !== "..") out.pop();
        else out.push("..");
      } else if (part && part !== ".") out.push(part);
    return (file.startsWith("/") ? "/" : "") + (out.join("/") || ".");
  },
  join: (...parts: string[]) =>
    posix.normalize(parts.filter(Boolean).join("/")),
  dirname: (file: string) =>
    file.includes("/") ? file.slice(0, file.lastIndexOf("/")) || "/" : ".",
};
const fromBase64 = (value: string) =>
  Uint8Array.from(atob(value.replace(/\s/g, "")), (c) => c.charCodeAt(0));
const utf8 = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const repoPath = (target: Target, ...parts: string[]) =>
  posix.join(target.recipe_path ?? "", ...parts).replace(/^\.\/?/, "");

async function readText(
  client: PlatformClient,
  target: Target,
  file: string,
): Promise<Uint8Array> {
  const content = await client.repositories.contents.get(
    target.repository!,
    file,
    { ref: target.commit },
  );
  if (content.type !== "file") throw new Error(`${file} is a directory`);
  if (content.truncated)
    throw new Error(
      `${file} is larger than the repository contents API returns whole`,
    );
  return content.encoding === "base64"
    ? fromBase64(content.content)
    : new TextEncoder().encode(content.content);
}

/** The git tree id of a directory at the commit, which names its content. */
async function treeId(
  client: PlatformClient,
  target: Target,
  dir: string,
): Promise<string> {
  const parent = posix.dirname(dir);
  for await (const entry of client.repositories.contents(target.repository!, {
    path: parent === "." ? "" : parent,
    ref: target.commit,
  }))
    if (entry.path === dir && entry.type === "dir") return entry.sha;
  throw new Error(`${dir} is not a directory at ${target.commit}`);
}

/** What a trial passes the platform beside its `task_path`: the compose world with each sidecar's image. */
export interface TaskDefinition {
  task: string;
  /** The task's own `environment/docker-compose.yaml`, or an empty document. */
  compose: Record<string, unknown>;
  /** Each sidecar's build context, as a repository path. */
  contexts: Record<string, string>;
}

export async function readTaskDefinition(
  client: PlatformClient,
  target: Target,
  task: string,
): Promise<TaskDefinition> {
  const dir = repoPath(target, TASKS_DIR, task);
  let compose: Record<string, unknown> = {};
  try {
    compose = (parseYaml(
      utf8(
        await readText(
          client,
          target,
          `${dir}/environment/docker-compose.yaml`,
        ),
      ),
    ) ?? {}) as Record<string, unknown>;
  } catch (error) {
    if (status(error) !== 404) throw error;
  }
  return {
    task,
    compose,
    contexts: buildContexts(compose, `${dir}/environment`),
  };
}

type Service = Record<string, unknown>;
const servicesOf = (document: Record<string, unknown>) =>
  (document.services ?? {}) as Record<string, Service | null>;

/** Each sidecar's `build:` context as a repository path. */
export function buildContexts(
  document: Record<string, unknown>,
  environmentDir: string,
): Record<string, string> {
  const contexts: Record<string, string> = {};
  for (const [name, service] of Object.entries(servicesOf(document))) {
    if (name === MAIN_SERVICE || !service) continue;
    const build = service.build;
    if (build === undefined) continue;
    const context =
      typeof build === "string"
        ? build
        : ((build as { context?: string; dockerfile?: string }).context ?? ".");
    if (
      typeof build === "object" &&
      (build as { dockerfile?: string }).dockerfile &&
      (build as { dockerfile?: string }).dockerfile !== "Dockerfile"
    )
      throw new Error(`service ${name} builds from another Dockerfile`);
    const resolved = posix.join(environmentDir, context);
    if (resolved.startsWith("..") || resolved.startsWith("/"))
      throw new Error(`service ${name} builds from outside the repository`);
    contexts[name] = resolved;
  }
  return contexts;
}

/**
 * The catalog name of a sidecar built from `context`: its git tree id names
 * its content, so a commit that leaves the context alone reuses the image.
 */
export const sidecarImageName = (service: string, tree: string) =>
  `trivia-night/${service}/${tree.slice(0, 12)}`;

/**
 * The image each sidecar runs: the ready catalog image for its context's
 * tree. The repository contents API returns no file over 1 MB whole, so the
 * page cannot pack the context itself; `pnpm sidecar:image` builds it from
 * this checkout once per change to the context.
 */
export async function sidecarImages(
  client: PlatformClient,
  target: Target,
  definition: TaskDefinition,
): Promise<Record<string, string>> {
  const references: Record<string, string> = {};
  for (const [name, context] of Object.entries(definition.contexts)) {
    const image = sidecarImageName(name, await treeId(client, target, context));
    const page = await client.images.list({ name: image, status: "ready" });
    const ready = page.records.find((record) => record.image_digest);
    if (!ready?.image_ref)
      throw new Error(
        `no ready ${image} image for ${context}/ at ${target.commit.slice(0, 12)}: run pnpm sidecar:image`,
      );
    references[name] = `${ready.image_ref}@${ready.image_digest}`;
  }
  for (const [name, service] of Object.entries(servicesOf(definition.compose)))
    if (name !== MAIN_SERVICE && service?.build === undefined)
      throw new Error(`service ${name} has no build context`);
  return references;
}

/** The task's compose with each sidecar on its catalog image and the verifier's volumes on `main`. */
export function trialCompose(
  document: Record<string, unknown>,
  references: Record<string, string>,
): Record<string, unknown> {
  const declared = servicesOf(document)[MAIN_SERVICE] ?? {};
  const unsupported = Object.keys(declared).filter(
    (key) => !MAIN_SERVICE_KEYS.has(key),
  );
  if (unsupported.length)
    throw new Error(
      `services.main declares ${unsupported.join(", ")}; the Runtime image fills main`,
    );
  const services: Record<string, unknown> = {
    [MAIN_SERVICE]: {
      ...declared,
      volumes: [
        ...((declared.volumes as string[] | undefined) ?? []),
        ...Object.entries(VERIFIER_VOLUMES).map(
          ([name, mount]) => `${name}:${mount}`,
        ),
      ],
    },
  };
  for (const [name, service] of Object.entries(servicesOf(document))) {
    if (name === MAIN_SERVICE) continue;
    const { build: _build, image: _image, ...rest } = service ?? {};
    services[name] = { ...rest, image: references[name] };
  }
  return {
    services,
    volumes: {
      ...((document.volumes as Record<string, unknown> | undefined) ?? {}),
      ...Object.fromEntries(
        Object.keys(VERIFIER_VOLUMES).map((v) => [v, null]),
      ),
    },
  };
}

/** The end user a step runs as: `anon:<id>` or `user:<id>`, carrying the run's tags to the member it mints. */
export function trialIdentity(step: Step): Record<string, unknown> {
  const [kind, ...rest] = step.identity.split(":");
  const id = rest.join(":");
  const field =
    kind === "anon" ? "anonymous_id" : kind === "user" ? "user_id" : null;
  if (!field || !id) throw new Error(`unsupported identity ${step.identity}`);
  return { [field]: id, tags: [runTag(step.run), TRIALS_TAG] };
}

/**
 * The step's `admission_key`: the platform creates one task per key for the
 * key's member, under a lock, so two polls that both create a step make one
 * trial between them. A uuid5 of the run and the step.
 */
export async function admissionKey(step: Step): Promise<string> {
  const namespace = ADMISSION_NAMESPACE.replace(/-/g, "");
  const name = new TextEncoder().encode(`${step.run}/${stepKey(step)}`);
  const input = new Uint8Array(16 + name.length);
  for (let i = 0; i < 16; i++)
    input[i] = parseInt(namespace.slice(i * 2, i * 2 + 2), 16);
  input.set(name, 16);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hexOf(hash.subarray(0, 16));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const hexOf = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The create body for one trial: the platform reads its prompt, its verifier
 * and its compose from `metadata.task_path`. The page passes the compose, since the
 * runtime's build carries no image for the trivia bank sidecar.
 */
export async function trialBody(
  record: RunRecord,
  step: Step,
  compose: Record<string, unknown>,
): Promise<CreateTaskParams> {
  const meta: TrialMeta = { step: stepKey(step), record };
  const taskPath = repoPath(record.target, TASKS_DIR, step.task);
  return {
    kind: "eval",
    runtime_id: record.target.runtime,
    recipe_git_commit_sha: record.target.commit,
    commands: true,
    tags: [runTag(step.run), TRIALS_TAG],
    compose,
    metadata: {
      task_path: taskPath,
      admission_key: await admissionKey(step),
      identity: trialIdentity(step),
      [TRIAL_METADATA_KEY]: meta,
    },
  };
}

/** Task definitions read in this request, so a run's steps share each task's reads. */
export type Definitions = Map<string, Promise<TaskDefinition>>;

const definitionOf = (
  client: PlatformClient,
  target: Target,
  task: string,
  cache: Definitions,
) => {
  let found = cache.get(task);
  if (!found) {
    found = readTaskDefinition(client, target, task);
    cache.set(task, found);
  }
  return found;
};

/**
 * Creates a step's trial, or returns the one another poll already made: the
 * platform admits one task per admission key, replaying the same body and
 * refusing another, after which the existing task is read back.
 */
export async function createTrial(
  client: PlatformClient,
  record: RunRecord,
  step: Step,
  cache: Definitions = new Map(),
): Promise<Task> {
  const definition = await definitionOf(
    client,
    record.target,
    step.task,
    cache,
  );
  const compose = trialCompose(
    definition.compose,
    await sidecarImages(client, record.target, definition),
  );
  try {
    const created = await client.tasks.create(
      await trialBody(record, step, compose),
    );
    return created.task;
  } catch (error) {
    if (status(error) !== 409) throw error;
    const key = stepKey(step);
    const existing = (await runTasks(client, record.run)).find(
      ({ meta }) => meta.step === key,
    );
    if (!existing) throw error;
    return existing.task;
  }
}

/** Every trial task of a run, oldest first. */
async function runTasks(
  client: PlatformClient,
  run: string,
): Promise<{ task: Task; meta: TrialMeta }[]> {
  const found: { task: Task; meta: TrialMeta }[] = [];
  for await (const task of client.tasks.list({
    tag: runTag(run),
    limit: 100,
  })) {
    const meta = trialMeta(task.metadata);
    if (meta?.record.run === run) found.push({ task, meta });
  }
  return found.sort((a, b) =>
    a.task.created_at.localeCompare(b.task.created_at),
  );
}

/** The newest run this page started, by id, or null. */
export async function latestRun(
  client: PlatformClient,
): Promise<string | null> {
  for await (const task of client.tasks.list({ tag: TRIALS_TAG, limit: 5 })) {
    const meta = trialMeta(task.metadata);
    if (meta) return meta.record.run;
  }
  return null;
}

/**
 * Moves a run on one step and says where it stands: a night whose
 * predecessors have ended starts, and one whose
 * predecessor failed is skipped. Idempotent, and safe to call from any
 * instance: each step's admission key makes one task of it however many
 * calls create it, and a run made before the key keeps a step's first task
 * and archives the others. With `advance` false it only reads, for a member
 * whose sign-in cannot move a run on.
 */
export async function advanceRun(
  client: PlatformClient,
  run: string,
  advance = true,
): Promise<RunView | null> {
  const tasks = await runTasks(client, run);
  if (!tasks.length) return null;
  const record = tasks[0].meta.record;
  const byStep = new Map<string, Task>();
  for (const { task, meta } of tasks) {
    if (!byStep.has(meta.step)) byStep.set(meta.step, task);
    else if (advance && !task.is_archived) await client.tasks.archive(task.id);
  }
  const cancelled = tasks.some(({ task }) => runCancelled(task.metadata));
  const cache: Definitions = new Map();
  const states = new Map<string, StepState>();
  const views: TrialView[] = [];
  for (const step of runSteps(record)) {
    const key = stepKey(step);
    let task = byStep.get(key);
    if (!task) {
      const next = untriedStep(step, states, cancelled);
      if (next.skip) {
        states.set(key, { done: true, failed: true, error: next.skip });
        views.push({
          key,
          step,
          task_id: null,
          status: "skipped",
          scored: false,
          done: true,
          finished: skippedTrial(step, next.skip),
        });
        continue;
      }
      if (!advance || next.wait) {
        views.push({
          key,
          step,
          task_id: null,
          status: "waiting",
          scored: false,
          done: false,
          finished: null,
        });
        continue;
      }
      task = await createTrial(client, record, step, cache);
    }
    const state = { ...trialState(task), status: task.status };
    states.set(key, state);
    views.push({
      key,
      step,
      task_id: task.id,
      status: task.status,
      scored: trialVerification(task.metadata) !== null,
      done: state.done,
      finished: null,
    });
  }
  const done = views.every((view) => view.done);
  const ends = tasks
    .map(({ task }) => task.completed_at ?? task.updated_at)
    .sort();
  return {
    run,
    record,
    trials: views,
    memory_off: tasks.some(({ task }) => !task.metadata?.memory),
    finished: done
      ? {
          run,
          seconds: Math.round(
            (Date.parse(ends[ends.length - 1] ?? record.started_at) -
              Date.parse(record.started_at)) /
              1000,
          ),
          trials: views.length,
          started_by: record.started_by,
        }
      : null,
  };
}

/** What a Run click asks for; `token` is the click's own, so a repeat of it starts nothing new. */
export interface StartRequest {
  venues: number;
  startedBy: string;
  /** The configured Runtime, its commit and its repository. */
  target: Target | null;
  token: string;
  teams?: TeamSize;
  pubs?: Pubs;
  now?: Date;
}

/** A run's id from the member and their click's token: the same click names the same run. */
export async function runIdFor(member: string, token: string): Promise<string> {
  const hash = hexOf(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${member}:${token}`),
      ),
    ),
  );
  return `r${parseInt(hash.slice(0, 13), 16)}`;
}

/**
 * Starts a run: records it on its first nights' tasks, which the page's polls
 * then move on. A repeat of the same click resolves to the run it started,
 * through its first trials' admission keys; another click while a run is
 * going is refused.
 */
export async function startRun(
  client: PlatformClient,
  request: StartRequest,
): Promise<{ run: string; target: Target }> {
  const now = request.now ?? new Date();
  const run = await runIdFor(request.startedBy, request.token);
  const latest = await latestRun(client);
  if (latest && latest !== run) {
    const view = await advanceRun(client, latest);
    if (view && !view.finished) throw new Error(`run ${latest} is still going`);
  }
  const target = await resolveTarget(client, request.target);
  const record: RunRecord = {
    run,
    venues: request.venues,
    teams: request.teams ?? DEFAULT_TEAMS,
    pubs: request.pubs ?? "development",
    started_by: request.startedBy,
    started_at: now.toISOString(),
    target,
  };
  const cache: Definitions = new Map();
  const first = runSteps(record).filter((step) => !step.after?.length);
  // The first trial records the run, so a failure here leaves no half-made run behind it.
  await createTrial(client, record, first[0], cache);
  // Past it the run exists: one the rest fail to make, `advanceRun` makes on the next poll.
  await Promise.allSettled(
    first.slice(1).map((step) => createTrial(client, record, step, cache)),
  );
  return { run: record.run, target };
}

/**
 * Cancels a run: marks it on its first trial, so no night is started after
 * it, then drains every trial still going, which then ends `cancelled`.
 */
export async function cancelRun(client: PlatformClient, run: string) {
  const tasks = await runTasks(client, run);
  if (!tasks.length) return;
  await client.tasks.update(tasks[0].task.id, {
    metadata: { [RUN_CANCELLED_KEY]: true },
  });
  await Promise.all(
    tasks
      .filter(({ task }) => !trialState(task).done)
      .map(async ({ task }) => {
        const runId =
          task.metadata?.active_run_id ?? task.metadata?.latest_run_id;
        if (typeof runId !== "string") return;
        try {
          await client.tasks.runs.cancel(task.id, runId, { mode: "drain" });
        } catch (error) {
          // A trial that ended meanwhile has no run to cancel.
          if (status(error) !== 409) throw error;
        }
      }),
  );
}

const decode = async (client: PlatformClient, id: string | null | undefined) =>
  id ? utf8(await client.files.download(id)) : null;

/** A finished trial's result from its verification's files. */
export async function trialResult(
  client: PlatformClient,
  taskId: string,
): Promise<EvalFinished | null> {
  const task = await client.tasks.get(taskId);
  const meta = trialMeta(task.metadata);
  if (!meta) return null;
  const step = runSteps(meta.record).find((s) => stepKey(s) === meta.step);
  if (!step) return null;
  const state = trialState(task);
  const verification = trialVerification(task.metadata);
  const [log, result] = await Promise.all([
    decode(client, verification?.log_file_id),
    decode(client, verification?.result_file_id),
  ]);
  const out = verifierOutput(log, result, verification?.reward ?? null);
  let night1Notes: string | null = null;
  if (step.night.startsWith("night2") && step.after?.length) {
    const before = (await runTasks(client, meta.record.run)).find(
      ({ meta: m }) => m.step === step.after![0],
    );
    const v = before && trialVerification(before.task.metadata);
    if (v)
      night1Notes = verifierOutput(
        await decode(client, v.log_file_id),
        await decode(client, v.result_file_id),
      ).notes;
  }
  const scoredAt = verification?.completed_at ?? task.completed_at;
  return {
    ...step,
    reward: out.reward,
    checks: out.checks,
    notes: previewNotes(out.notes),
    fetches: out.fetches,
    rounds: out.rounds,
    // The runtime loads memory only for a trial that owns it.
    steps:
      night1Notes &&
      task.metadata?.memory &&
      !out.steps.some((event) => event.type === "memory.read")
        ? [loadedMemory(night1Notes), ...out.steps]
        : out.steps,
    steps_error: out.steps_error,
    measures:
      log || result
        ? measuresOf(step.night, {
            checks: out.checks,
            notes: out.notes,
            fetches: out.fetches,
            tastes: out.tastes,
            night1Notes,
          })
        : {},
    seconds:
      task.started_at && scoredAt
        ? Math.round(
            (Date.parse(scoredAt) - Date.parse(task.started_at)) / 1000,
          )
        : 0,
    exit_code: verification?.exit_code ?? null,
    error: state.error,
  };
}

/**
 * A run's results without moving it on: each scored trial's, and the record
 * of each night skipped because one before it failed. Null for no such run.
 */
export async function runResults(
  client: PlatformClient,
  run: string,
): Promise<EvalFinished[] | null> {
  const tasks = await runTasks(client, run);
  if (!tasks.length) return null;
  const byStep = new Map<string, Task>();
  for (const { task, meta } of tasks)
    if (!byStep.has(meta.step)) byStep.set(meta.step, task);
  const cancelled = tasks.some(({ task }) => runCancelled(task.metadata));
  const states = new Map<string, StepState>();
  const results: EvalFinished[] = [];
  for (const step of runSteps(tasks[0].meta.record)) {
    const key = stepKey(step);
    const task = byStep.get(key);
    if (!task) {
      const next = untriedStep(step, states, cancelled);
      if (next.skip) {
        states.set(key, { done: true, failed: true, error: next.skip });
        results.push(skippedTrial(step, next.skip));
      }
      continue;
    }
    const state = { ...trialState(task), status: task.status };
    states.set(key, state);
    if (!state.done) continue;
    const result = await trialResult(client, task.id);
    if (result) results.push(result);
  }
  return results;
}
