/**
 * An eval task the platform verifies, driven through the real SDK against a
 * recorded Data Plane: create with a verifier, compose and Recipe commit,
 * complete it once idle, read it `finishing`, then read its verification
 * under strict decoding and download its result file.
 *
 * Record against a LOCAL stack only, with an agent key in
 * `INTROSPECTION_TOKEN_FILE`, the planes in `INTROSPECTION_API_BASE_URL` and
 * `INTROSPECTION_DP_URL`, and a git-backed Runtime with no required MCP
 * server in `EVAL_RUNTIME_ID` / `EVAL_RECIPE_COMMIT`:
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
const ARCHIVE = path.resolve(here, "../fixtures/eval-verifier/tests.tar.gz");
const WAIT_MS = 10 * 60 * 1000;

interface Bootstrap {
  api: string;
  dp: string;
  runtime: string;
  commit: string;
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

    it("creates a kind=eval task carrying its verifier, compose and Recipe commit", async () => {
      const archive = await client.files.upload({
        file: fs.readFileSync(ARCHIVE),
        name: "tests.tar.gz",
        contentType: "application/gzip",
        ttl_seconds: 3600,
      });
      const created = await client.tasks.create({
        prompt: "Reply with the single word done. Do not call any tool.",
        kind: "eval",
        runtime_id: settings.runtime,
        recipe_git_commit_sha: settings.commit,
        commands: true,
        idle_timeout_seconds: 600,
        compose: {
          services: { main: { volumes: ["logs:/logs", "tests:/tests"] } },
          volumes: { logs: null, tests: null },
        },
        verifier: {
          tests_file_id: archive.id,
          command: ["sh", "/tests/test.sh"],
          reward_path: "/logs/verifier/result.json",
          timeout_seconds: 60,
        },
      });
      task = created.task;
      expect(task.kind).toBe("eval");
      expect(task.metadata?.verification).toBeUndefined();
    });

    it("completes the idle task, which the platform verifies while finishing", async () => {
      await until("idle");
      const completed = await client.tasks.update(task.id, {
        status: "completed",
      });
      expect(completed.status).toBe("finishing");
    }, 660_000);

    it("reads the verification under strict decoding, and its result file", async () => {
      await until("completed");
      const read = await strict.tasks.get(task.id);
      expect(read.status).toBe("completed");
      const verification = read.metadata?.verification as TaskVerification;
      expect(verification.reward).toBe(1);
      expect(verification.exit_code).toBe(0);
      expect(verification.error).toBeUndefined();
      const result = JSON.parse(
        Buffer.from(
          await client.files.download(verification.result_file_id!),
        ).toString("utf8"),
      ) as Record<string, number>;
      expect(result).toEqual({ reward: 1, ran: 1 });
      const log = Buffer.from(
        await client.files.download(verification.log_file_id!),
      ).toString("utf8");
      expect(log).toContain("verifier ran");
    }, 660_000);
  },
);
