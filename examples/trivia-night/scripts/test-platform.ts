/**
 * The eval runner against the real SDK and a recorded platform: one pub's run
 * from its first trials to its results, replayed from
 * `tests/recordings/trivia-night-platform_*`. `pnpm test` replays it;
 * `pnpm test:platform:record` records it against a LOCAL stack only, with a
 * bearer token of that stack's project in the file `TRIVIA_RECORD_TOKEN_FILE`
 * standing in for the member's (the page's sign-in needs a browser), and
 * `INTROSPECTION_API_BASE_URL`, `INTROSPECTION_DP_URL`,
 * `INTROSPECTION_TRIVIA_RUNTIME_ID` and `INTROSPECTION_TRIVIA_COMMIT_SHA` set
 * (`.env.local`). Waits poll on the native fetch, which the recording never
 * sees; each decision is one recorded call.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  ConflictError,
  IntrospectionClient,
  type Task,
} from "@introspection-sdk/introspection-node";

const RECORDING = "trivia-night-platform";
const RECORDINGS = path.resolve(__dirname, "../../../tests/recordings");
const BOOTSTRAP = path.join(RECORDINGS, RECORDING, "run.json");
const NATIVE_FETCH: typeof fetch = globalThis.fetch;
const WAIT_MS = 20 * 60 * 1000;

interface Bootstrap {
  started_at: string;
  api: string;
  dp: string;
  runtime: string;
  commit: string;
  project: string;
  member: string;
  /** The click that starts the recorded run, new each recording so it names a new run. */
  click: string;
  /** A Runtime of the project whose commit has no generated venue tasks, as the page is configured with one. */
  untasked: { runtime: string; commit: string; repository: string };
  /** The repository holding the Runtime's Recipe, at its root. */
  repository: string;
}

async function main() {
  const { getPollyMode, setupPolly } =
    await import("../../../tests/polly-setup");
  const mode = getPollyMode();
  const live = mode !== "replay";
  const recordToken = live
    ? readFileSync(process.env.TRIVIA_RECORD_TOKEN_FILE ?? "", "utf8").trim()
    : "polly-replay";
  if (mode === "record") {
    const api = process.env.INTROSPECTION_API_BASE_URL ?? "";
    if (!/^http:\/\/localhost:/.test(api))
      throw new Error("record against a local stack only");
    const cp = new IntrospectionClient({
      token: recordToken,
      advanced: { baseApiUrl: api, dpUrl: process.env.INTROSPECTION_DP_URL },
    });
    const runtime = await cp.runtimes.get(
      process.env.INTROSPECTION_TRIVIA_RUNTIME_ID ?? "",
    );
    const recipe = await cp.recipes.get(runtime.recipe_id);
    const bootstrap: Bootstrap = {
      project: runtime.project_id,
      repository: recipe.repository_id,
      member: "recorded-member",
      click: `recorded-${Date.now()}`,
      untasked: await (async () => {
        const other = await cp.runtimes.get(
          process.env.TRIVIA_RECORD_UNTASKED_RUNTIME_ID ?? "",
        );
        return {
          runtime: other.id,
          commit: other.git_commit_sha ?? "",
          repository: (await cp.recipes.get(other.recipe_id)).repository_id,
        };
      })(),
      started_at: new Date().toISOString(),
      api,
      dp: process.env.INTROSPECTION_DP_URL ?? api,
      runtime: process.env.INTROSPECTION_TRIVIA_RUNTIME_ID ?? "",
      commit: process.env.INTROSPECTION_TRIVIA_COMMIT_SHA ?? "",
    };
    mkdirSync(path.dirname(BOOTSTRAP), { recursive: true });
    writeFileSync(BOOTSTRAP, `${JSON.stringify(bootstrap, null, 2)}\n`);
  }
  const bootstrap = JSON.parse(readFileSync(BOOTSTRAP, "utf8")) as Bootstrap;
  const env: Record<string, string | undefined> = {
    INTROSPECTION_API_BASE_URL: bootstrap.api,
    INTROSPECTION_DP_URL: bootstrap.dp,
    INTROSPECTION_TRIVIA_RUNTIME_ID: bootstrap.runtime,
    INTROSPECTION_TRIVIA_COMMIT_SHA: bootstrap.commit,
  };
  Object.assign(process.env, env);

  const polly = setupPolly({ recordingName: RECORDING, ordered: true });
  let passed = 0;
  async function check(name: string, run: () => Promise<void>) {
    await run();
    passed += 1;
    console.log(`ok  ${name}`);
  }
  try {
    const runner = await import("../lib/platform-runner");
    const evals = await import("../lib/platform-evals");
    const token = recordToken;
    // The page's own calls through the Node client with a bearer token, which the recording can hold.
    const client = new IntrospectionClient({
      token,
      advanced: { baseApiUrl: bootstrap.api, dpUrl: bootstrap.dp },
    });
    const quiet = new IntrospectionClient({
      token,
      advanced: {
        baseApiUrl: bootstrap.api,
        dpUrl: bootstrap.dp,
        fetch: NATIVE_FETCH,
      },
    });
    /** When a live recording first saw each task at each status, for the report. */
    const statusSeen: Record<string, Record<string, number>> = {};
    /** Waits, off the recording, until the run's tasks say `ready`. */
    const until = async (
      run: string,
      ready: (tasks: Task[]) => boolean,
      label: string,
    ) => {
      if (!live) return;
      const deadline = Date.now() + WAIT_MS;
      for (;;) {
        const page = await quiet.tasks.list({
          tag: evals.runTag(run),
          limit: 100,
        });
        for (const task of page.records) {
          const seen = (statusSeen[task.id] ??= {});
          seen[task.status] ??= Date.now();
        }
        if (ready(page.records)) return;
        if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    };
    const stepOf = (task: Task) => evals.trialMeta(task.metadata)?.step;
    const ENDED = new Set(["completed", "failed", "cancelled"]);

    const configured = {
      runtime: bootstrap.runtime,
      commit: bootstrap.commit,
      repository: bootstrap.repository,
      recipe_path: "",
    };
    const target = await runner.resolveTarget(client, configured);
    const record = {
      run: await runner.runIdFor(bootstrap.member, bootstrap.click),
      venues: 1,
      teams: evals.DEFAULT_TEAMS,
      pubs: "development" as const,
      started_by: bootstrap.member,
      started_at: bootstrap.started_at,
      target,
    };
    const steps = evals.runSteps(record);
    const first = steps[0];

    await check(
      "platform evals: the run takes a Runtime whose commit holds the generated tasks",
      async () => {
        assert.equal(await runner.hasTasks(client, target), true);
        // A configured Runtime without them is refused, saying how to push them.
        const untasked = { ...bootstrap.untasked, recipe_path: "" };
        assert.equal(await runner.hasTasks(client, untasked), false);
        await assert.rejects(
          runner.resolveTarget(client, untasked),
          (error) => error instanceof runner.NoTasks,
        );
        await assert.rejects(
          runner.resolveTarget(client, null),
          /no trivia Runtime/,
        );
        assert.match(
          new runner.NoTasks("trivia-night").message,
          /generated venue tasks.*pnpm dev.*runtimes create --manifest/,
        );
      },
    );

    await check(
      "platform evals: a Harbor task's compose is read from the Runtime's repository, with its sidecar's image",
      async () => {
        assert.equal(target.runtime, bootstrap.runtime);
        assert.equal(target.commit, bootstrap.commit);
        const definition = await runner.readTaskDefinition(
          client,
          target,
          first.task,
        );
        assert.ok(Object.keys(definition.contexts).length > 0);
        const images = await runner.sidecarImages(client, target, definition);
        for (const [service, reference] of Object.entries(images)) {
          assert.ok(service in definition.contexts);
          assert.match(reference, /@sha256:[0-9a-f]{64}$/);
        }
        const compose = runner.trialCompose(definition.compose, images);
        const services = compose.services as Record<string, { image?: string }>;
        for (const [service, reference] of Object.entries(images))
          assert.equal(services[service].image, reference);
        // A context no image was built for says how to build it.
        await assert.rejects(
          runner.sidecarImages(client, target, {
            ...definition,
            contexts: { [Object.keys(definition.contexts)[0]]: "evals" },
          }),
          /pnpm sidecar:image/,
        );
      },
    );

    const request = {
      venues: record.venues,
      startedBy: record.started_by,
      target: configured,
      token: bootstrap.click,
      teams: record.teams,
      pubs: record.pubs,
      now: new Date(bootstrap.started_at),
    };
    const started = await runner.startRun(client, request);
    const run = started.run;

    await check(
      "platform evals: a run starts each pub's first nights as kind=eval tasks",
      async () => {
        assert.equal(run, record.run);
        const view = (await runner.advanceRun(client, run))!;
        assert.deepEqual(
          view.trials.map((t) => [t.key, t.task_id !== null]),
          steps.map((s) => [evals.stepKey(s), !s.after?.length]),
        );
        for (const trial of view.trials)
          if (trial.step.after?.length) assert.equal(trial.status, "waiting");
        const task = await client.tasks.get(view.trials[0].task_id!);
        assert.equal(task.kind, "eval");
        assert.ok(task.tags?.includes(evals.runTag(run)));
        assert.ok(task.tags?.includes(evals.TRIALS_TAG));
        assert.equal(
          task.metadata?.admission_key,
          await runner.admissionKey(first),
        );
        // The same click again is the same run; another click while it goes is refused.
        const again = await runner.startRun(client, {
          ...request,
          now: new Date(Date.parse(bootstrap.started_at) + 1000),
        });
        assert.equal(again.run, run);
        const listed = await client.tasks.list({
          tag: evals.runTag(run),
          limit: 100,
        });
        assert.equal(
          listed.records.length,
          steps.filter((s) => !s.after?.length).length,
        );
        await assert.rejects(
          runner.startRun(client, { ...request, token: "another-click" }),
          /still going/,
        );
      },
    );

    await check(
      "platform evals: a second create of a step makes no second trial",
      async () => {
        // The same body again is the same task: the platform replays the step's admission key.
        const definition = await runner.readTaskDefinition(
          client,
          target,
          first.task,
        );
        const images = await runner.sidecarImages(client, target, definition);
        const body = await runner.trialBody(
          record,
          first,
          runner.trialCompose(definition.compose, images),
        );
        const replayed = await client.tasks.create(body);
        // Under another body, the key is refused.
        await assert.rejects(
          client.tasks.create({
            ...body,
            tags: [...(body.tags ?? []), "other"],
          }),
          (error) => error instanceof ConflictError,
        );
        const again = await runner.createTrial(client, record, first);
        const view = (await runner.advanceRun(client, run))!;
        assert.equal(again.id, view.trials[0].task_id);
        assert.equal(replayed.task.id, again.id);
        const listed = await client.tasks.list({
          tag: evals.runTag(run),
          limit: 100,
        });
        assert.equal(
          listed.records.filter((t) => stepOf(t) === evals.stepKey(first))
            .length,
          1,
        );
      },
    );

    const seedKey = steps.find((s) => s.night === "night0-seed")!;
    const seed = evals.stepKey(seedKey);
    await check(
      "platform evals: a night whose predecessor failed is skipped, and the others chain to the end",
      async () => {
        let view = (await runner.advanceRun(client, run))!;
        const seedTask = await client.tasks.get(
          view.trials.find((t) => t.key === seed)!.task_id!,
        );
        const runId = String(
          seedTask.metadata?.active_run_id ?? seedTask.metadata?.latest_run_id,
        );
        await client.tasks.runs.cancel(seedTask.id, runId, { mode: "drain" });
        await until(
          run,
          (tasks) =>
            tasks.some((t) => stepOf(t) === seed && ENDED.has(t.status)),
          "night 0 cancelled",
        );
        // Each recorded advance follows a change that moves the run on.
        const moves = (tasks: { id: string; status: string }[]) =>
          tasks
            .filter((t) => t.status === "idle" || ENDED.has(t.status))
            .map((t) => `${t.id}:${t.status}`)
            .sort()
            .join(",") + `#${tasks.length}`;
        for (;;) {
          view = (await runner.advanceRun(client, run))!;
          if (view.finished) break;
          const seen = moves(
            view.trials.flatMap((t) =>
              t.task_id ? [{ id: t.task_id, status: t.status }] : [],
            ),
          );
          await until(run, (tasks) => moves(tasks) !== seen, "the run moves");
        }
        const byKey = new Map(view.trials.map((t) => [t.key, t]));
        const perfect = steps.find((s) => s.after?.[0] === seed)!;
        assert.equal(byKey.get(evals.stepKey(perfect))?.status, "skipped");
        assert.equal(
          byKey.get(evals.stepKey(perfect))?.finished?.error,
          "skipped: night0-seed cancelled",
        );
        assert.equal(view.finished?.trials, steps.length);
        assert.equal(view.finished?.started_by, bootstrap.member);
        const hostedStep = steps.find((s) => s.night === "night2-hosted")!;
        const hosted = await client.tasks.get(
          byKey.get(evals.stepKey(hostedStep))!.task_id!,
        );
        const night1 = await client.tasks.get(
          byKey.get(evals.stepKey(first))!.task_id!,
        );
        // Night 1 was completed by the run, so it was verified, before its night 2 was made.
        assert.equal(night1.status, "completed");
        assert.ok(evals.trialVerification(night1.metadata));
        assert.ok(hosted.created_at >= night1.completed_at!);
        // The same customer plays night 2, so it reads night 1's notes.
        assert.deepEqual(hosted.metadata?.identity, night1.metadata?.identity);
      },
    );

    await check(
      "platform evals: a trial's result is read from its verification",
      async () => {
        const view = (await runner.advanceRun(client, run))!;
        const byKey = new Map(view.trials.map((t) => [t.key, t]));
        const hostedKey = `${first.venue}/night2-hosted`;
        const hosted = (await runner.trialResult(
          client,
          byKey.get(hostedKey)!.task_id!,
        ))!;
        assert.equal(hosted.night, "night2-hosted");
        assert.equal(typeof hosted.reward, "number");
        assert.ok(hosted.seconds > 0);
        assert.equal(hosted.error, null);
        assert.ok(Object.keys(hosted.checks).length > 0);
        // What the host did, kept by the verifier from the sandbox's own record.
        const kinds = new Set(hosted.steps?.map((step) => step.type));
        for (const kind of ["bank.served", "host.planned"])
          assert.ok(kinds.has(kind as never), `night 2 has a ${kind} step`);
        // The run says whether its trials owned memory, and shows the runtime's load only when they did.
        const memory = (await client.tasks.get(byKey.get(hostedKey)!.task_id!))
          .metadata?.memory as { remote_prefix?: string } | undefined;
        const owned = Boolean(memory);
        // The model-notes night 2 owns the memory its night 1 wrote.
        assert.ok(owned, "night 2 owns memory");
        if (live) console.log(`    night 2 memory: ${memory?.remote_prefix}`);
        assert.equal(view.memory_off, !owned);
        assert.equal(
          Boolean(hosted.steps?.some((step) => step.key === "runtime:memory")),
          owned,
        );
        const night1 = (await runner.trialResult(
          client,
          byKey.get(evals.stepKey(first))!.task_id!,
        ))!;
        assert.ok(night1.steps?.some((step) => step.type === "memory.written"));
        // The report carries the crowd's tastes, so the notes are scored without the task's files.
        assert.equal(typeof night1.measures?.notes_accuracy, "number");
        const cancelled = (await runner.trialResult(
          client,
          byKey.get(seed)!.task_id!,
        ))!;
        assert.ok(cancelled.error);
        assert.deepEqual(cancelled.measures, {});

        const results = (await runner.runResults(client, run))!;
        assert.deepEqual(
          results.map((r) => `${r.venue}/${r.night}`),
          steps.map(evals.stepKey),
        );
        assert.equal(await runner.latestRun(client), run);
      },
    );
    if (live)
      for (const [id, seen] of Object.entries(statusSeen))
        console.log(
          `    ${id}: ${Object.entries(seen)
            .map(([status, at]) => `${status}@${new Date(at).toISOString()}`)
            .join(" ")}`,
        );
  } finally {
    await polly.stop();
  }
  console.log(`\n${passed} platform checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
