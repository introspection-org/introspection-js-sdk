/**
 * Runs the memory evals on the platform from the page, as plain calls through
 * the SDK with the signed-in member's own token: each trial is a `kind: eval`
 * task of the project's trivia Runtime that scores itself with its Harbor
 * task's own verifier, billed to the member's organization. Nothing is held
 * here between requests: a run is its tasks, found by their tag, and
 * `advanceRun` moves it on from what they say. Server only.
 */
import { createHash } from "node:crypto";
import path from "node:path";

import {
  ConflictError,
  IntrospectionClient,
  NotFoundError,
  type Runtime,
  type Task,
  type TaskCreateParams,
} from "@introspection-sdk/introspection-node";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

import { measuresOf, type VenueTastes } from "./memory-measures";
import {
  DEFAULT_TEAMS,
  PUB_SETS,
  taskName,
  previewNotes,
  readyToComplete,
  runSteps,
  runTag,
  skippedTrial,
  stepKey,
  TRIAL_METADATA_KEY,
  TRIALS_TAG,
  trialMeta,
  trialState,
  trialVerification,
  verifierOutput,
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
import { tarGz, type TarFile } from "./tar";
import { loadedMemory } from "./trial-steps";

export type Env = Record<string, string | undefined>;

const DEFAULT_API_BASE_URL = "https://api.introspection.dev";
/** The Runtime a project adds from this repository's manifest, or the one `pnpm dev` creates. */
const RUNTIME_SLUGS = ["trivia-night", "trivia-host"];
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
/** The verifier's whole result; reward.json beside it holds only Harbor's numbers. */
const REWARD_PATH = "/logs/verifier/result.json";
const DEFAULT_VERIFIER_SECONDS = 120;
/** The sandbox's ceiling, which also releases a wedged trial's. */
const TRIAL_CEILING_SECONDS = 3600;
/** The verifier archive only has to outlive its trial. */
const ARCHIVE_TTL_SECONDS = 2 * 24 * 3600;
/** The uuid5 namespace a step's admission key is derived in. */
const ADMISSION_NAMESPACE = "6f1c2a8e-3b4d-5e6f-8a9b-0c1d2e3f4a5b";

/** The Control Plane the page signs in with and finds the Runtime on. */
export function apiBaseUrl(env: Env = process.env): string {
  return env.INTROSPECTION_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL;
}

/** The Data Plane the trials run on; a stack that serves both on one host needs none. */
export function dpBaseUrl(env: Env = process.env): string {
  return env.INTROSPECTION_DP_URL?.trim() || apiBaseUrl(env);
}

export type PlatformClient = Pick<
  IntrospectionClient,
  "tasks" | "files" | "images" | "repositories" | "runtimes" | "recipes"
>;

/** A client acting as the signed-in member, with their own access token. */
export function memberClient(
  session: { access_token: string; dp_url: string | null },
  env: Env = process.env,
): IntrospectionClient {
  return new IntrospectionClient({
    token: session.access_token,
    advanced: {
      baseApiUrl: apiBaseUrl(env),
      dpUrl: session.dp_url || dpBaseUrl(env),
    },
  });
}

/** A project with no trivia Runtime, which the panel says how to add. */
export class NoRuntime extends Error {
  constructor() {
    super(ADD_RUNTIME);
  }
}

/** The project's trivia Runtimes run commits without the generated venue tasks. */
export class NoTasks extends Error {
  constructor(slugs: string[]) {
    super(
      `the ${slugs.join(" and ")} runtime${slugs.length === 1 ? "" : "s"} carry no generated venue tasks (evals/harbor is git-ignored): push them with the recipe, as pnpm dev does, after ${ADD_RUNTIME.replace(/^add/, "adding")}`,
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
    if (error instanceof NotFoundError) return false;
    throw error;
  }
}

/**
 * The Runtime the trials run, the commit they run at, and the repository that
 * holds its Recipe: `INTROSPECTION_TRIVIA_RUNTIME_ID` when it is in the
 * project, then the project's trivia-night or trivia-host Runtime, the first
 * whose commit holds the generated venue tasks.
 */
export async function resolveTarget(
  client: PlatformClient,
  project: string,
  env: Env = process.env,
): Promise<Target> {
  const candidates: { runtime: Runtime; pinned: boolean }[] = [];
  const pinnedId = env.INTROSPECTION_TRIVIA_RUNTIME_ID?.trim();
  if (pinnedId) {
    try {
      const read = await client.runtimes.get(pinnedId);
      if (read.project_id === project)
        candidates.push({ runtime: read, pinned: true });
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
  }
  for (const slug of RUNTIME_SLUGS) {
    try {
      const found = await client.runtimes.resolve(slug, project);
      if (!candidates.some(({ runtime }) => runtime.id === found.id))
        candidates.push({ runtime: found, pinned: false });
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
  }
  if (!candidates.length) throw new NoRuntime();
  for (const { runtime, pinned } of candidates) {
    // The pinned commit goes with the pinned Runtime only.
    const commit =
      (pinned && env.INTROSPECTION_TRIVIA_COMMIT_SHA?.trim()) ||
      runtime.git_commit_sha;
    if (!commit || !runtime.recipe_id) continue;
    const recipe = await client.recipes.get(runtime.recipe_id);
    const target: Target = {
      runtime: runtime.id,
      commit,
      slug: runtime.slug,
      repository: recipe.repository_id,
      recipe_path:
        recipe.sub_path && recipe.sub_path !== "." ? recipe.sub_path : "",
    };
    if (await hasTasks(client, target)) return target;
  }
  throw new NoTasks(candidates.map(({ runtime }) => runtime.slug));
}

const repoPath = (target: Target, ...parts: string[]) =>
  path.posix.join(target.recipe_path ?? "", ...parts).replace(/^\.\/?/, "");

async function readText(
  client: PlatformClient,
  target: Target,
  file: string,
): Promise<Buffer> {
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
  return Buffer.from(
    content.content,
    content.encoding === "base64" ? "base64" : "utf8",
  );
}

/** Every file under `dir` at the commit, with paths relative to it. */
async function readTree(
  client: PlatformClient,
  target: Target,
  dir: string,
): Promise<{ path: string; content: Buffer }[]> {
  const files: { path: string; content: Buffer }[] = [];
  for await (const entry of client.repositories.contents(target.repository!, {
    path: dir,
    ref: target.commit,
  })) {
    if (entry.type === "dir")
      for (const child of await readTree(client, target, entry.path))
        files.push({
          path: `${entry.name}/${child.path}`,
          content: child.content,
        });
    else
      files.push({
        path: entry.name,
        content: await readText(client, target, entry.path),
      });
  }
  return files;
}

/** The git tree id of a directory at the commit, which names its content. */
async function treeId(
  client: PlatformClient,
  target: Target,
  dir: string,
): Promise<string> {
  const parent = path.posix.dirname(dir);
  for await (const entry of client.repositories.contents(target.repository!, {
    path: parent === "." ? "" : parent,
    ref: target.commit,
  }))
    if (entry.path === dir && entry.type === "dir") return entry.sha;
  throw new Error(`${dir} is not a directory at ${target.commit}`);
}

/** A Harbor task as the trial needs it, read from the Runtime's repository at the commit. */
export interface TaskDefinition {
  task: string;
  instruction: string;
  verifierSeconds: number;
  tests: TarFile[];
  /** The task's own `environment/docker-compose.yaml`, or an empty document. */
  compose: Record<string, unknown>;
  /** Each sidecar's build context, as a repository path. */
  contexts: Record<string, string>;
  tastes: VenueTastes | null;
}

export async function readTaskDefinition(
  client: PlatformClient,
  target: Target,
  task: string,
): Promise<TaskDefinition> {
  const dir = repoPath(target, TASKS_DIR, task);
  const [instruction, toml, tests] = await Promise.all([
    readText(client, target, `${dir}/instruction.md`),
    readText(client, target, `${dir}/task.toml`),
    readTree(client, target, `${dir}/tests`),
  ]);
  let compose: Record<string, unknown> = {};
  try {
    compose = (parseYaml(
      (
        await readText(client, target, `${dir}/environment/docker-compose.yaml`)
      ).toString("utf8"),
    ) ?? {}) as Record<string, unknown>;
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
  }
  const config = parseToml(toml.toString("utf8")) as {
    verifier?: { timeout_sec?: number };
  };
  const expected = tests.find((file) => file.path === "expected.json");
  return {
    task,
    instruction: instruction.toString("utf8").trim(),
    // One over the Data Plane's command timeout is refused at create, not clamped.
    verifierSeconds: Math.max(
      1,
      Math.round(config.verifier?.timeout_sec ?? DEFAULT_VERIFIER_SECONDS),
    ),
    tests: tests.map((file) => ({
      path: file.path,
      content: file.content,
      mode: file.path.endsWith(".sh") ? 0o755 : 0o644,
    })),
    compose,
    contexts: buildContexts(compose, `${dir}/environment`),
    tastes: expected
      ? (JSON.parse(expected.content.toString("utf8")) as VenueTastes)
      : null,
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
    const resolved = path.posix.normalize(
      path.posix.join(environmentDir, context),
    );
    if (resolved.startsWith("..") || path.posix.isAbsolute(resolved))
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
export function admissionKey(step: Step): string {
  const hash = createHash("sha1")
    .update(Buffer.from(ADMISSION_NAMESPACE.replace(/-/g, ""), "hex"))
    .update(`${step.run}/${stepKey(step)}`)
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The create body for one trial, given its verifier archive. */
export function trialBody(
  record: RunRecord,
  step: Step,
  definition: TaskDefinition,
  compose: Record<string, unknown>,
  testsFileId: string,
): TaskCreateParams {
  const meta: TrialMeta = { step: stepKey(step), record };
  return {
    prompt: definition.instruction,
    kind: "eval",
    runtime_id: record.target.runtime,
    recipe_git_commit_sha: record.target.commit,
    commands: true,
    idle_timeout_seconds: TRIAL_CEILING_SECONDS,
    tags: [runTag(step.run), TRIALS_TAG],
    compose,
    verifier: {
      tests_file_id: testsFileId,
      command: ["sh", "/tests/test.sh"],
      reward_path: REWARD_PATH,
      timeout_seconds: definition.verifierSeconds,
    },
    metadata: {
      admission_key: admissionKey(step),
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
 * platform refuses a second create under the step's admission key whose body
 * differs (its verifier archive is a new upload), and replays one that does not.
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
  const archive = await client.files.upload({
    file: tarGz(definition.tests),
    name: `${step.task}-tests.tar.gz`,
    contentType: "application/gzip",
    ttl_seconds: ARCHIVE_TTL_SECONDS,
  });
  try {
    const created = await client.tasks.create(
      trialBody(record, step, definition, compose, archive.id),
    );
    return created.task;
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    const key = stepKey(step);
    const existing = (await runTasks(client, record.run)).find(
      ({ meta }) => meta.step === key,
    );
    if (!existing) throw error;
    return existing.task;
  }
}

/** Ends a settled trial so the platform verifies it; another poll that got there first is no error. */
async function completeTrial(client: PlatformClient, taskId: string) {
  try {
    await client.tasks.update(taskId, { status: "completed" });
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
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

const skipReason = (failed: string[]) =>
  `skipped: ${failed.map((k) => k.split("/")[1]).join(", ")} failed`;

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
 * Moves a run on one step and says where it stands: a settled trial is ended
 * so the platform verifies it, a night whose predecessors have ended starts, and one whose
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
  const cache: Definitions = new Map();
  const states = new Map<string, ReturnType<typeof trialState>>();
  const views: TrialView[] = [];
  for (const step of runSteps(record)) {
    const key = stepKey(step);
    let task = byStep.get(key);
    if (!task) {
      const before = (step.after ?? []).map((k) => [k, states.get(k)] as const);
      const failed = before.filter(([, state]) => state?.failed);
      if (failed.length) {
        const reason = skipReason(failed.map(([k]) => k));
        states.set(key, { done: true, failed: true, error: reason });
        views.push({
          key,
          step,
          task_id: null,
          status: "skipped",
          scored: false,
          done: true,
          finished: skippedTrial(step, reason),
        });
        continue;
      }
      if (!advance || before.some(([, state]) => !state?.done)) {
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
    if (advance && readyToComplete(task)) await completeTrial(client, task.id);
    const state = trialState(task);
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
  /** The member's project, which their token acts in. */
  project: string;
  token: string;
  teams?: TeamSize;
  pubs?: Pubs;
  now?: Date;
}

/** A run's id from the member and their click's token: the same click names the same run. */
export function runIdFor(member: string, token: string): string {
  const hash = createHash("sha256").update(`${member}:${token}`).digest("hex");
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
  const run = runIdFor(request.startedBy, request.token);
  const latest = await latestRun(client);
  if (latest && latest !== run) {
    const view = await advanceRun(client, latest);
    if (view && !view.finished) throw new Error(`run ${latest} is still going`);
  }
  const target = await resolveTarget(client, request.project);
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
  await Promise.all(
    first.slice(1).map((step) => createTrial(client, record, step, cache)),
  );
  return { run: record.run, target };
}

const decode = async (client: PlatformClient, id: string | null | undefined) =>
  id ? Buffer.from(await client.files.download(id)).toString("utf8") : null;

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
  const [log, result, definition] = await Promise.all([
    decode(client, verification?.log_file_id),
    decode(client, verification?.result_file_id),
    readTaskDefinition(client, meta.record.target, step.task),
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
            tastes: definition.tastes,
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
  const failed = new Set<string>();
  const results: EvalFinished[] = [];
  for (const step of runSteps(tasks[0].meta.record)) {
    const key = stepKey(step);
    const task = byStep.get(key);
    if (!task) {
      const before = (step.after ?? []).filter((k) => failed.has(k));
      if (before.length) {
        failed.add(key);
        results.push(skippedTrial(step, skipReason(before)));
      }
      continue;
    }
    const state = trialState(task);
    if (state.failed) failed.add(key);
    if (!state.done) continue;
    const result = await trialResult(client, task.id);
    if (result) results.push(result);
  }
  return results;
}
