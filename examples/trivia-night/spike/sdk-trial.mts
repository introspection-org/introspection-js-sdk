// Spike: one trivia-night trial through the JS SDK alone, as the trivia-night
// SPA would run it in the browser: no CLI, no Harbor, no API key file.
//
// It does what the CLI's Harbor platform environment does for a trial
// (introspection-cli packages/harbor/src/introspection_harbor/task_environment.py):
// build the task's fakes sidecar image from an uploaded context, create a
// `kind: eval` task at a commit with that sidecar and a per-pub identity, run
// the night's instruction, upload the task's tests, run its verifier through
// `tasks.commands`, and download `reward.json`.
//
//   TOKEN_FILE   a file holding the bearer token (a member's access token, or
//                an API key); read from disk, never passed on the command line
//   TOKEN_JSON_FIELD  read the token from this field when TOKEN_FILE is JSON
//   DP_URL       the Data Plane URL
//   RUNTIME_ID   the trivia-host runtime
//   COMMIT       the trivia-host commit to run
//   TASK_DIR     a generated Harbor task folder, e.g. evals/harbor/night0-sydney
//   FAKES_DIR    the Recipe's fakes/ folder (the sidecar's build context)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DataPlaneClient } from "../../../packages/introspection-node/src/data-plane.ts";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const raw = readFileSync(env("TOKEN_FILE"), "utf8").trim();
const token = process.env.TOKEN_JSON_FIELD
  ? (JSON.parse(raw)[process.env.TOKEN_JSON_FIELD] as string)
  : raw;
const taskDir = env("TASK_DIR");
const fakesDir = env("FAKES_DIR");
const pub = path.basename(taskDir).replace(/^night\d-/, "");
const client = new DataPlaneClient({ dpUrl: env("DP_URL"), token });
const log = (...a: unknown[]) =>
  console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TRANSFER = { encryption: false, purpose: "harbor_transfer" };
const transfers: string[] = [];

// 1. The sidecar image, built by the platform from an uploaded fakes folder
// (a compose `build.context` must be an uploaded archive's file id).
let imageRef: string | undefined;
{
  const scratch = mkdtempSync(path.join(tmpdir(), "trivia-spike-"));
  const archive = path.join(scratch, "fakes-context.tar.gz");
  execFileSync("tar", [
    "-czf",
    archive,
    "-C",
    fakesDir,
    "--exclude=node_modules",
    "--exclude=tests",
    "--exclude=runs",
    "--exclude=series",
    "--exclude=*.md",
    ".",
  ]);
  const context = await client.files.upload({
    file: readFileSync(archive),
    name: "fakes-context.tar.gz",
    metadata: TRANSFER,
  });
  log("context uploaded", context.id);
  transfers.push(context.id);
  let image = await client.images.create({
    name: "trivia-spike/fakes",
    source: { kind: "context", file_id: context.id, dockerfile: "Dockerfile" },
    provenance: { service: "fakes" },
  } as never);
  while (!["ready", "failed", "cancelled"].includes(String(image.status))) {
    await sleep(3000);
    image = await client.images.get(image.id);
  }
  if (image.status !== "ready")
    throw new Error(`image ${image.id} is ${image.status}: ${image.error}`);
  // The Python SDK's `pull_reference`: the image reference pinned to its digest.
  imageRef =
    image.image_ref && image.image_digest && !image.image_ref.includes("@")
      ? `${image.image_ref}@${image.image_digest}`
      : image.image_ref;
  if (!imageRef)
    throw new Error(`image ${image.id} is ready but has no reference`);
  log("image ready", imageRef);
}

// 2. The eval task: the Recipe at a commit, the fakes as a sidecar, a pub identity.
const compose = {
  services: {
    main: {
      volumes: [
        "fakes-verifier:/opt/fakes-verifier:ro",
        "harbor-logs:/logs",
        "harbor-tests:/tests",
      ],
      depends_on: { fakes: { condition: "service_healthy", required: true } },
    },
    fakes: {
      image: imageRef,
      environment: {
        EVAL_SIMULATE_SCENARIO: `crowd-page-${pub}`,
        EVAL_SIMULATE_NIGHT: "1",
        EVAL_SIMULATE_SERIES_NIGHTS: "2",
        EVAL_SIMULATE_TEAMS: "5",
        EVAL_SIMULATE_MANIFEST_DIR: "/verifier",
      },
      volumes: ["fakes-verifier:/verifier"],
      healthcheck: {
        test: [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:7353/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))",
        ],
        interval: "1s",
        retries: 30,
      },
    },
  },
  volumes: { "fakes-verifier": {}, "harbor-logs": {}, "harbor-tests": {} },
};
const identity = {
  anonymous_id: `sim-spike-${Date.now()}-${pub}`,
  tags: ["simulation:spike"],
};
const created = await client.tasks.create({
  runtime_id: env("RUNTIME_ID"),
  kind: "eval",
  commands: true,
  idle_timeout_seconds: 900,
  recipe_git_commit_sha: env("COMMIT"),
  compose,
  metadata: { identity, harbor: { environment: "sdk-spike" } },
} as never);
const taskId = created.task.id;
log("task created", taskId);
let task = await client.tasks.get(taskId);
while (!["running", "awaiting_user", "idle"].includes(String(task.status))) {
  if (["completed", "failed", "cancelled"].includes(String(task.status)))
    throw new Error(
      `task ${taskId} is ${task.status}: ${JSON.stringify(task.metadata?.error ?? null)}`,
    );
  await sleep(2000);
  task = await client.tasks.get(taskId);
}
log("sandbox ready", task.status);

// 3. The night: the task's instruction as the trivia master's message.
const instruction = readFileSync(path.join(taskDir, "instruction.md"), "utf8");
const run = await client.tasks.runs.create(taskId, {
  prompt: { text: instruction },
} as never);
const reply = await run.text();
log("host replied", JSON.stringify(reply.slice(0, 160)));

// 4. The verifier: upload the tests, run them, download reward.json.
const command = async (spec: object) => {
  let row = await client.tasks.commands.create(taskId, spec as never);
  while (!["completed", "failed", "cancelled"].includes(String(row.status)))
    row = await client.tasks.commands.get(taskId, row.id, { wait_seconds: 60 });
  return row;
};
for (const name of readdirSync(path.join(taskDir, "tests"))) {
  const file = await client.files.upload({
    file: readFileSync(path.join(taskDir, "tests", name)),
    name,
    metadata: TRANSFER,
  });
  transfers.push(file.id);
  const row = await command({
    kind: "upload",
    file_id: file.id,
    path: `/tests/${name}`,
  });
  if (row.status !== "completed")
    throw new Error(`upload ${name}: ${row.error}`);
}
const verify = await command({
  kind: "exec",
  command: ["sh", "/tests/test.sh"],
  timeout_seconds: 120,
});
log(
  "verifier",
  verify.status,
  "exit",
  verify.exit_code,
  (verify.stderr ?? "").slice(0, 200),
);
const got = await command({
  kind: "download",
  path: "/logs/verifier/reward.json",
});
const reward = got.output_file_id
  ? new TextDecoder().decode(await client.files.download(got.output_file_id))
  : `(no file: ${got.error})`;
if (got.output_file_id) transfers.push(got.output_file_id);
log("reward.json", reward);

// 5. Who it ran as, and whether it kept memory for the pub.
task = await client.tasks.get(taskId);
const md = (task.metadata ?? {}) as Record<string, unknown>;
console.log(
  JSON.stringify(
    {
      task_id: taskId,
      member_id: (task as unknown as Record<string, unknown>).member_id,
      identity: md.identity,
      memory: md.memory ?? null,
      runtime_environment: md.runtime_environment,
      recipe_sha: (
        md.spawn_resolution as
          Record<string, Record<string, unknown>> | undefined
      )?.contract?.recipe_sha,
    },
    null,
    1,
  ),
);
await client.tasks.archive(taskId);
for (const id of transfers)
  await client.files.delete(id).catch(() => undefined);
log("archived", taskId, "and removed", transfers.length, "transfer files");
