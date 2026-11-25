/**
 * An eval task the platform verifies, driven through the real SDK against a
 * recorded Data Plane: created with a Harbor task directory in
 * `metadata.task_path` (the platform reads its prompt and verifier there), it
 * ends on its own once its run settles, reads `finishing` while the verifier
 * runs, and then `completed` with `metadata.verification` under strict
 * decoding, whose result and log files download.
 *
 * Record against a LOCAL stack only, with a bearer token of its project in
 * `INTROSPECTION_TOKEN_FILE`, the planes in `INTROSPECTION_API_BASE_URL` and
 * `INTROSPECTION_DP_URL`, a git-backed Runtime holding the task in
 * `EVAL_RUNTIME_ID` / `EVAL_RECIPE_COMMIT` / `EVAL_TASK_PATH`, and the compose
 * its sidecar runs (the Runtime's build carries no image for a branch commit)
 * in the file `EVAL_COMPOSE_FILE`:
 * `POLLY_MODE=record pnpm --filter introspection-tests test api/eval-verifier.test.ts`.
 * Waits poll on the native fetch, which the recording never sees.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Polly } from "@pollyjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  IntrospectionClient,
  type Task,
  type TaskVerification,
} from "@introspection-sdk/introspection-node";
import { getPollyMode, setupPolly } from "../polly-setup";

const NATIVE_FETCH: typeof fetch = globalThis.fetch;
const RECORDING = "eval-verifier";
const here = path.dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP = path.resolve(here, "../recordings", RECORDING, "run.json");
const WAIT_MS = 15 * 60 * 1000;

interface Bootstrap {
  api: string;
  dp: string;
  runtime: string;
  commit: string;
  task_path: string;
  compose: Record<string, unknown>;
  anonymous_id: string;
}

const mode = getPollyMode();
const live = mode !== "replay";
const replayable = live || fs.existsSync(BOOTSTRAP);

function bootstrap(): Bootstrap {
  if (mode !== "record")
    return JSON.parse(fs.readFileSync(BOOTSTRAP, "utf8")) as Bootstrap;
  const api = process.env.INTROSPECTION_API_BASE_URL ?? "";
  if (!/^http:\/\/localhost:/.test(api))
    throw new Error("record against a local stack only");
  const value: Bootstrap = {
    api,
    dp: process.env.INTROSPECTION_DP_URL ?? api,
    runtime: process.env.EVAL_RUNTIME_ID ?? "",
    commit: process.env.EVAL_RECIPE_COMMIT ?? "",
    task_path: process.env.EVAL_TASK_PATH ?? "",
    compose: JSON.parse(
      fs.readFileSync(process.env.EVAL_COMPOSE_FILE ?? "", "utf8"),
    ) as Record<string, unknown>,
    anonymous_id: `eval-verifier-${Date.now()}`,
  };
  fs.mkdirSync(path.dirname(BOOTSTRAP), { recursive: true });
  fs.writeFileSync(BOOTSTRAP, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

const token = () =>
  live
    ? fs.readFileSync(process.env.INTROSPECTION_TOKEN_FILE ?? "", "utf8").trim()
    : "polly-replay";

(replayable ? describe : describe.skip)(
  "an eval task verified by the platform",
  { concurrent: false },
  () => {
    let polly: Polly;
    let settings: Bootstrap;
    let client: IntrospectionClient;
    let strict: IntrospectionClient;
    let quiet: IntrospectionClient;
    let task: Task;

    /** Polls off the recording until the task's status is `want`. */
    const until = async (want: string) => {
      if (!live) return;
      const deadline = Date.now() + WAIT_MS;
      for (;;) {
        const read = await quiet.tasks.get(task.id);
        if (read.status === want) return;
        if (["failed", "cancelled"].includes(read.status))
          throw new Error(`the task ended ${read.status}`);
        if (Date.now() > deadline) throw new Error(`timed out for ${want}`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    };

    beforeAll(() => {
      settings = bootstrap();
      polly = setupPolly({ recordingName: RECORDING, ordered: true });
      const advanced = { baseApiUrl: settings.api, dpUrl: settings.dp };
      client = new IntrospectionClient({ token: token(), advanced });
      strict = new IntrospectionClient({
        token: token(),
        advanced: { ...advanced, strictSchema: true },
      });
      quiet = new IntrospectionClient({
        token: token(),
        advanced: { ...advanced, fetch: NATIVE_FETCH },
      });
    });

    afterAll(async () => {
      await polly?.stop();
    });

    it("creates a kind=eval task from its metadata.task_path", async () => {
      const created = await client.tasks.create({
        kind: "eval",
        runtime_id: settings.runtime,
        recipe_git_commit_sha: settings.commit,
        commands: true,
        compose: settings.compose,
        metadata: {
          task_path: settings.task_path,
          identity: { anonymous_id: settings.anonymous_id },
        },
      });
      task = created.task;
      expect(task.kind).toBe("eval");
      expect(task.metadata?.verification).toBeUndefined();
    });

    it("ends on its own and reads completed with its verification, under strict decoding", async () => {
      await until("completed");
      const read = await strict.tasks.get(task.id);
      expect(read.status).toBe("completed");
      const verification = read.metadata?.verification as TaskVerification;
      expect(typeof verification.reward).toBe("number");
      expect(verification.exit_code).toBe(0);
      expect(verification.error).toBeUndefined();
      const result = JSON.parse(
        Buffer.from(
          await client.files.download(verification.result_file_id!),
        ).toString("utf8"),
      ) as Record<string, number>;
      expect(result.reward).toBe(verification.reward);
      const log = Buffer.from(
        await client.files.download(verification.log_file_id!),
      ).toString("utf8");
      expect(log).toContain('"notes_seeded"');
    }, 960_000);
  },
);
