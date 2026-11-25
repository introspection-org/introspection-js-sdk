/**
 * The eval runner against the real SDK and a recorded platform: one pub's run
 * from its first trials to its results, replayed from
 * `tests/recordings/trivia-night-platform_*`. `pnpm test` replays it;
 * `pnpm test:platform:record` records it against a LOCAL stack only, with
 * `TRIVIA_EVAL_KEY_FILE`, `INTROSPECTION_API_BASE_URL`, `INTROSPECTION_DP_URL`,
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
}

async function main() {
  const { getPollyMode, setupPolly } =
    await import("../../../tests/polly-setup");
  const mode = getPollyMode();
  const live = mode !== "replay";
  if (mode === "record") {
    const api = process.env.INTROSPECTION_API_BASE_URL ?? "";
    if (!/^http:\/\/localhost:/.test(api))
      throw new Error("record against a local stack only");
    const bootstrap: Bootstrap = {
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
    ...(live
      ? { TRIVIA_EVAL_KEY_FILE: process.env.TRIVIA_EVAL_KEY_FILE }
      : { TRIVIA_AGENT_KEY: "polly-replay" }),
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
    const client = runner.platformClient(env);
    const key = runner.agentKey(env);
    const quiet = new IntrospectionClient({
      token: "token" in key ? key.token : "",
      advanced: {
        baseApiUrl: bootstrap.api,
        dpUrl: bootstrap.dp,
        fetch: NATIVE_FETCH,
      },
    });
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
        if (ready(page.records)) return;
        if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    };
    const stepOf = (task: Task) => evals.trialMeta(task.metadata)?.step;
    const ENDED = new Set(["completed", "failed", "cancelled"]);

    const target = await runner.resolveTarget(client, env);
    const record = {
      run: evals.newRunId(new Date(bootstrap.started_at)),
      venues: 1,
      teams: evals.DEFAULT_TEAMS,
      pubs: "development" as const,
      started_by: "m-test",
      started_at: bootstrap.started_at,
      target,
    };
    const steps = evals.runSteps(record);
    const first = steps[0];

    await check(
      "platform evals: a Harbor task is read from the Runtime's repository at its commit",
      async () => {
        assert.equal(target.runtime, bootstrap.runtime);
        assert.equal(target.commit, bootstrap.commit);
        const definition = await runner.readTaskDefinition(
          client,
          target,
          first.task,
        );
        assert.ok(definition.instruction.length > 0);
        assert.ok(definition.verifierSeconds >= 1);
        assert.equal(
          definition.tests.find((file) => file.path === "test.sh")?.mode,
          0o755,
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

    const started = await runner.startRun(
      client,
      record.venues,
      record.started_by,
      record.teams,
      record.pubs,
      new Date(bootstrap.started_at),
    );
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
        assert.equal(task.metadata?.admission_key, runner.admissionKey(first));
        await assert.rejects(
          runner.startRun(client, 1, "m-test"),
          /still going/,
        );
      },
    );

    await check(
      "platform evals: a second create of a step makes no second trial",
      async () => {
        const definition = await runner.readTaskDefinition(
          client,
          target,
          first.task,
        );
        const images = await runner.sidecarImages(client, target, definition);
        const archive = await client.files.upload({
          file: (await import("../lib/tar")).tarGz(definition.tests),
          name: `${first.task}-tests.tar.gz`,
          contentType: "application/gzip",
          ttl_seconds: 3600,
        });
        // The platform refuses the key under another body: here, another archive.
        await assert.rejects(
          client.tasks.create(
            runner.trialBody(
              record,
              first,
              definition,
              runner.trialCompose(definition.compose, images),
              archive.id,
            ),
          ),
          (error) => error instanceof ConflictError,
        );
        const again = await runner.createTrial(client, record, first);
        const view = (await runner.advanceRun(client, run))!;
        assert.equal(again.id, view.trials[0].task_id);
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
          "skipped: night0-seed failed",
        );
        assert.equal(view.finished?.trials, steps.length);
        assert.equal(view.finished?.started_by, "m-test");
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
        for (const kind of ["memory.read", "bank.served", "host.planned"])
          assert.ok(kinds.has(kind as never), `night 2 has a ${kind} step`);
        const night1 = (await runner.trialResult(
          client,
          byKey.get(evals.stepKey(first))!.task_id!,
        ))!;
        assert.ok(night1.steps?.some((step) => step.type === "memory.written"));
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
  } finally {
    await polly.stop();
  }
  console.log(`\n${passed} platform checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
