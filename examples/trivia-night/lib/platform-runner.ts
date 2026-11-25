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

import { measuresOf, type VenueTastes } from "./memory-measures";
import {
  DEFAULT_TEAMS,
  trialOfStep,
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
  verificationFile,
  REPORT_FILE,
  REWARD_FILE,
  runCancelled,
  untriedStep,
  verifierOutput,
  RUN_CANCELLED_KEY,
  TARGET,
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
import {
  instructionFor,
  trialWorld,
} from "../recipe-operator/evals/trivia-tasks.mjs";

export type Env = Record<string, string | undefined>;

export const ADD_RUNTIME =
  "add the trivia-night runtime to the trivia project, from the repository's root: introspection runtimes create --manifest .introspection/trivia-night.yaml -p trivia";
/** Where the Harbor tasks sit in the repository: the Recipe's evals/harbor. */
const TASKS_DIR = "examples/trivia-night/recipe-operator/evals/harbor";
/** The bank sidecar's build context, packed by scripts/sidecar-context.ts under public/. */
export const SIDECAR_ARCHIVE = "sidecar/fakes.tar.gz";
const SIDECAR_TTL_SECONDS = 24 * 3600;
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
export type PlatformClient = Pick<IntrospectionApiClient, "tasks" | "files">;

const status = (error: unknown) => (error as { status?: number }).status;

/**
 * The bank sidecar's build context as a Files API id, uploaded once per
 * client. The platform builds an image once per archive, so every trial after
 * the first change to the folder runs the image already built.
 */
export type BankContext = () => Promise<string>;
const contexts = new WeakMap<PlatformClient, Promise<string>>();
export function bankContext(
  client: PlatformClient,
  archive: () => Promise<Uint8Array> = async () => {
    const response = await fetch(`/${SIDECAR_ARCHIVE}`);
    if (!response.ok)
      throw new Error(
        `the page has no ${SIDECAR_ARCHIVE}: run it with pnpm dev:app, which packs it`,
      );
    return new Uint8Array(await response.arrayBuffer());
  },
): BankContext {
  return () => {
    let found = contexts.get(client);
    if (!found) {
      found = archive()
        .then((file) =>
          client.files.upload({
            file,
            name: "fakes-context.tar.gz",
            contentType: "application/gzip",
            ttl_seconds: SIDECAR_TTL_SECONDS,
          }),
        )
        .then((upload) => upload.id);
      found.catch(() => contexts.delete(client));
      contexts.set(client, found);
    }
    return found;
  };
}

/** A trial's compose world: the bank built from its archive, and the verifier's volumes on `main`. */
export function trialCompose(
  step: Step,
  context: string,
): Record<string, unknown> {
  const trial = trialOfStep(step);
  const world = trialWorld(
    asVenue(trial.venue),
    trial.night,
    trial.teams,
    context,
  ) as {
    services: Record<string, Record<string, unknown>>;
    volumes: Record<string, unknown>;
  };
  const main = world.services.main;
  main.volumes = [
    ...(main.volumes as string[]),
    ...Object.entries(VERIFIER_VOLUMES).map(([name, at]) => `${name}:${at}`),
  ];
  return {
    services: world.services,
    volumes: {
      ...world.volumes,
      ...Object.fromEntries(
        Object.keys(VERIFIER_VOLUMES).map((v) => [v, null]),
      ),
    },
  };
}

/**
 * Which runtime a trial runs on: the project's trivia-night, at the version
 * the Data Plane deploys for the lane.
 */
// todo: name the runtime as task create takes a slug (introspection-cloud #4275).
export const trialRuntime = (target: Target) =>
  ({ runtime_slug: target.runtime }) as Pick<CreateTaskParams, "runtime_id">;

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
 * The create body for one trial: one of the Recipe's three Harbor tasks in
 * `metadata.task_path`, whose verifier the platform runs, with the pub it
 * plays, its instruction and its compose world.
 */
export async function trialBody(
  record: RunRecord,
  step: Step,
  compose: Record<string, unknown>,
): Promise<CreateTaskParams> {
  const trial = trialOfStep(step);
  const meta: TrialMeta = {
    step: stepKey(step),
    record,
    trial: { pub: trial.venue.slug, night: trial.night, teams: trial.teams },
  };
  return {
    kind: "eval",
    // The pub's instruction, as the generator would write it, so the platform needn't read it.
    prompt: instructionFor(asVenue(trial.venue), trial.night, trial.teams),
    ...trialRuntime(record.target),
    commands: true,
    tags: [runTag(step.run), TRIALS_TAG],
    compose,
    metadata: {
      task_path: `${TASKS_DIR}/night${trial.night}`,
      admission_key: await admissionKey(step),
      identity: trialIdentity(step),
      [TRIAL_METADATA_KEY]: meta,
    },
  };
}

/** A venues.json entry as the shared task module types it. */
const asVenue = (venue: unknown) =>
  venue as Parameters<typeof instructionFor>[0];

/**
 * Creates a step's trial, or returns the one another poll already made: the
 * platform admits one task per admission key, replaying the same body and
 * refusing another, after which the existing task is read back.
 */
export async function createTrial(
  client: PlatformClient,
  record: RunRecord,
  step: Step,
  context: BankContext = bankContext(client),
): Promise<Task> {
  const compose = trialCompose(step, await context());
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
  const context = bankContext(client);
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
      task = await createTrial(client, record, step, context);
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
  const target = TARGET;
  const record: RunRecord = {
    run,
    venues: request.venues,
    teams: request.teams ?? DEFAULT_TEAMS,
    pubs: request.pubs ?? "development",
    started_by: request.startedBy,
    started_at: now.toISOString(),
    target,
  };
  const context = bankContext(client);
  const first = runSteps(record).filter((step) => !step.after?.length);
  // The first trial records the run, so a failure here leaves no half-made run behind it.
  await createTrial(client, record, first[0], context);
  // Past it the run exists: one the rest fail to make, `advanceRun` makes on the next poll.
  await Promise.allSettled(
    first.slice(1).map((step) => createTrial(client, record, step, context)),
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

const utf8 = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
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
    decode(client, verificationFile(verification, REPORT_FILE)),
    decode(client, verificationFile(verification, REWARD_FILE)),
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
        await decode(client, verificationFile(v, REPORT_FILE)),
        await decode(client, verificationFile(v, REWARD_FILE)),
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
