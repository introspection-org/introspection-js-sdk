/**
 * Play simulated rooms against a deployed trivia host, as its trivia master.
 *
 * Each venue is one end user, started with a project API key naming its
 * `user_id`, so the host keeps one memory per venue and the bank keys its
 * history on the same identity. A night is one task: the driver gives the team
 * names, then each round's answer sheet from the venue's table, and sends a
 * thumbs-down when a round lands outside the target band. The bank (served by
 * `pnpm dev` with TRIVIA_ROOMS_API=1) says what was served and how it scored.
 *
 *   INTROSPECTION_TASK_TOKEN=… pnpm rooms --arm control=<runtime-id> --nights 4
 *   pnpm rooms --arm control=<id> --arm notes=<id> --reps 2 --label pass-1
 *   pnpm rooms --report runs/rooms/<run>
 *
 * The task token reaches the CLI in its environment, never its arguments.
 */
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";

import { IntrospectionLogs } from "@introspection-sdk/introspection-node/otel";

import type { RoomState } from "../lib/rooms";
import { seeded, TARGET, teamAnswer, VENUES, type Venue } from "../lib/venues";
import {
  answerSheet,
  ASKS_ABOUT_VENUE,
  describe,
  opening,
  teamsFor,
  TONIGHT_ONLY,
  TOO_EASY,
  TOO_HARD,
} from "./room-master";
import { report } from "./scorecard";

const run = promisify(execFile);
const CLI = process.env.INTROSPECTION_BIN ?? "introspection";
const BANK = process.env.TRIVIA_BANK_URL ?? "http://localhost:3500";
const SETTLED = new Set(["awaiting_user", "idle", "completed"]);
const FAILED = new Set(["failed", "cancelled"]);
const MAX_TURNS = 16;

export interface NightRecord {
  arm: string;
  runtime_id: string;
  venue: string;
  held_out: boolean;
  rep: number;
  night: number;
  user_id: string;
  task_id?: string;
  conversation_id?: string;
  week?: number;
  rounds: RoomState["rounds"];
  standings: RoomState["standings"];
  turns: number;
  /** Times the host asked the trivia master about the venue. */
  venue_asks: number;
  feedback: { round: number; rate: number; comment?: string }[];
  memory: Record<string, string>;
  seconds: number;
  cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
  error?: string;
}

interface Task {
  id: string;
  status: string;
  member_id?: string;
  metadata?: Record<string, unknown>;
}

const taskEnv = () => {
  const token = process.env.INTROSPECTION_TASK_TOKEN;
  if (!token)
    throw new Error("set INTROSPECTION_TASK_TOKEN to a project API key");
  return { ...process.env, INTROSPECTION_TOKEN: token };
};

async function cli(args: string[], env?: NodeJS.ProcessEnv): Promise<unknown> {
  try {
    const { stdout } = await run(CLI, [...args, "-o", "json"], {
      env: env ?? process.env,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.trim() ? JSON.parse(stdout) : undefined;
  } catch (error) {
    const failure = error as { stderr?: string; message: string };
    throw new Error(
      `introspection ${args.slice(0, 2).join(" ")}: ${failure.stderr?.trim() || failure.message}`,
    );
  }
}

async function room(owner: string): Promise<RoomState> {
  const response = await fetch(
    `${BANK}/api/rooms?owner=${encodeURIComponent(owner)}`,
  );
  if (!response.ok)
    throw new Error(
      `the bank's rooms API answered ${response.status}; start it with TRIVIA_ROOMS_API=1`,
    );
  return (await response.json()) as RoomState;
}

async function resetRoom(owner: string): Promise<void> {
  const response = await fetch(
    `${BANK}/api/rooms?owner=${encodeURIComponent(owner)}`,
    { method: "DELETE" },
  );
  if (!response.ok)
    throw new Error(`could not reset ${owner}: ${response.status}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The night's model spend, from the conversation's spans. */
async function usage(
  conversationId: string,
  since: Date,
): Promise<{ cost: number; input: number; output: number }> {
  const query = {
    view: "spans",
    metrics: [
      { measure: "gen_ai.cost.usd", aggregation: "sum" },
      { measure: "gen_ai.usage.input_tokens", aggregation: "sum" },
      { measure: "gen_ai.usage.output_tokens", aggregation: "sum" },
    ],
    filters: [
      {
        field: "gen_ai.conversation.id",
        operator: "eq",
        value: conversationId,
      },
    ],
    from_timestamp: new Date(since.getTime() - 60_000).toISOString(),
    to_timestamp: new Date(Date.now() + 60_000).toISOString(),
  };
  const dir = mkdtempSync(join(tmpdir(), "trivia-usage-"));
  const file = join(dir, "query.json");
  writeFileSync(file, JSON.stringify(query));
  const result = (await cli(["metrics", "query", `@${file}`])) as {
    data: { metrics: { value: number }[] }[];
  };
  const values = result.data[0]?.metrics.map((metric) => metric.value) ?? [];
  return {
    cost: values[0] ?? 0,
    input: values[1] ?? 0,
    output: values[2] ?? 0,
  };
}

/** A turn can read as settled a moment before the task takes another. */
async function send(taskId: string, reply: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await cli(["tasks", "prompt", taskId, "--prompt", reply]);
      return;
    } catch (error) {
      if (attempt >= 6 || !(error as Error).message.includes("409"))
        throw error;
      await sleep(5000);
    }
  }
}

async function settle(taskId: string, timeout: number): Promise<Task> {
  const deadline = Date.now() + timeout * 1000;
  for (;;) {
    const task = (await cli(["tasks", "get", taskId])) as Task;
    if (SETTLED.has(task.status)) return task;
    if (FAILED.has(task.status))
      throw new Error(
        `task ${taskId} ended ${task.status}: ${JSON.stringify(task.metadata?.error ?? "")}`,
      );
    if (Date.now() > deadline)
      throw new Error(`task ${taskId} still ${task.status} after ${timeout}s`);
    await sleep(3000);
  }
}

async function lastReply(taskId: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "trivia-reply-"));
  const file = join(dir, "trajectory.json");
  await cli([
    "conversations",
    "get",
    taskId,
    "--format",
    "trajectory",
    "--output-file",
    file,
  ]);
  const records = JSON.parse(readFileSync(file, "utf8")) as {
    role?: string;
    content?: unknown;
  }[];
  for (const record of records.reverse()) {
    if (record.role !== "assistant") continue;
    const text = Array.isArray(record.content)
      ? record.content
          .map((part: { text?: string }) => part.text ?? "")
          .join("\n")
      : String(record.content ?? "");
    if (text.trim()) return text;
  }
  return "";
}

async function memoryFiles(
  task: Task,
): Promise<{ id: string; name: string }[]> {
  if (!task.member_id) return [];
  const environment = String(task.metadata?.runtime_environment ?? "staging");
  const prefix = `memory/${environment}/member:${task.member_id}/`;
  const listed = (await cli([
    "files",
    "list",
    "--filter",
    "category=memory",
    "--filter",
    `name_contains=${prefix}`,
  ])) as
    | { records?: { id: string; name: string }[] }
    | { id: string; name: string }[]
    | undefined;
  return (Array.isArray(listed) ? listed : listed?.records) ?? [];
}

async function readMemory(
  task: Task,
  folder: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const file of await memoryFiles(task)) {
    const name = file.name.split("/").slice(3).join("/");
    const path = join(folder, name);
    mkdirSync(join(path, ".."), { recursive: true });
    await cli(["files", "content", file.id, "--out", path]);
    out[name] = readFileSync(path, "utf8");
  }
  return out;
}

async function night(
  arm: string,
  runtimeId: string,
  venue: Venue,
  rep: number,
  nightNo: number,
  out: string,
  logs: IntrospectionLogs | undefined,
  options: { turnTimeout: number; runId: string },
): Promise<NightRecord> {
  const userId = `${arm}.${venue.id}.r${rep}`;
  const owner = `user:${userId}`;
  const started = Date.now();
  const record: NightRecord = {
    arm,
    runtime_id: runtimeId,
    venue: venue.id,
    held_out: venue.heldOut,
    rep,
    night: nightNo,
    user_id: userId,
    rounds: [],
    standings: [],
    turns: 0,
    venue_asks: 0,
    feedback: [],
    memory: {},
    seconds: 0,
  };
  const random = seeded(1000 * rep + 17 * nightNo + venue.id.length);
  const feedbackRandom = seeded(7 * rep + nightNo);
  try {
    const before = await room(owner);
    const roundsBefore = before.rounds.length;
    let prompt = opening(venue, nightNo);
    const extra = TONIGHT_ONLY[venue.id];
    if (extra?.week === nightNo) prompt += ` ${extra.ask}`;
    const created = (await cli(
      [
        "tasks",
        "create",
        "--runtime-id",
        runtimeId,
        "--environment",
        "staging",
        "--subject",
        userId,
        "--prompt",
        prompt,
        "--tag",
        `simulation:${options.runId}`,
        "--tag",
        `arm:${arm}`,
        "--idle-timeout",
        "120",
      ],
      taskEnv(),
    )) as { task?: Task } & Task;
    const taskId = (created.task ?? created).id;
    record.task_id = taskId;
    let task = await settle(taskId, options.turnTimeout);
    record.conversation_id = String(task.metadata?.conversation_id ?? "");
    let seen = roundsBefore;
    for (record.turns = 1; record.turns < MAX_TURNS; record.turns += 1) {
      const state = await room(owner);
      for (const [index, round] of state.rounds.slice(seen).entries()) {
        const rate = round.answers ? round.correct / round.answers : 0;
        if (rate < TARGET.low || rate > TARGET.high) {
          const comment =
            feedbackRandom() < 0.4
              ? (rate < TARGET.low ? TOO_HARD : TOO_EASY)[
                  Math.floor(feedbackRandom() * 2)
                ]
              : undefined;
          record.feedback.push({
            round: seen - roundsBefore + index + 1,
            rate,
            comment,
          });
          logs?.feedback("thumbs_down", {
            conversationId: record.conversation_id,
            ...(comment && { comments: comment }),
            round: seen - roundsBefore + index + 1,
            share_right: Math.round(rate * 100) / 100,
          });
        }
      }
      seen = state.rounds.length;
      const tonight = state.rounds.filter((round) => round.week === state.week);
      let reply: string;
      // A trivia master asked about the venue answers, wherever it falls.
      // A message reading out a round holds quiz questions, not questions
      // for the trivia master.
      const asked =
        !state.pending.length && ASKS_ABOUT_VENUE.test(await lastReply(taskId));
      if (asked) record.venue_asks += 1;
      const about = asked ? `${describe(venue)} ` : "";
      if (state.week <= before.week)
        reply =
          "Please start tonight's night with the bank before anything else.";
      else if (!state.teams.length)
        reply = `Tonight's teams: ${teamsFor(venue).join(", ")}.`;
      else if (state.pending.length) reply = answerSheet(venue, state, random);
      else if (tonight.length >= 3 && task.status !== "awaiting_user") break;
      else if (tonight.length >= 3)
        reply = "Thanks, that's the night. See you next week.";
      else reply = "Sounds good, go ahead.";
      if (tonight.length >= 3 && reply.startsWith("Thanks")) {
        await send(taskId, reply);
        task = await settle(taskId, options.turnTimeout);
        break;
      }
      if (about && !state.pending.length) reply = `${about}${reply}`;
      await send(taskId, reply);
      task = await settle(taskId, options.turnTimeout);
    }
    const final = await room(owner);
    record.week = final.week;
    record.rounds = final.rounds.slice(roundsBefore);
    record.standings = final.standings;
    // Spans land in telemetry a little after the turn ends.
    await sleep(10_000);
    const spent = await usage(record.conversation_id, new Date(started));
    record.cost_usd = spent.cost;
    record.input_tokens = spent.input;
    record.output_tokens = spent.output;
    record.memory = await readMemory(
      task,
      join(out, "memory", userId, `night-${nightNo}`),
    );
    await cli([
      "conversations",
      "get",
      taskId,
      "--format",
      "trajectory",
      "--output-file",
      join(out, "transcripts", `${userId}-night-${nightNo}.json`),
    ]);
  } catch (error) {
    record.error = (error as Error).message;
  }
  record.seconds = Math.round((Date.now() - started) / 1000);
  return record;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      arm: { type: "string", multiple: true },
      venues: { type: "string" },
      "held-out": { type: "boolean", default: false },
      nights: { type: "string", default: "4" },
      reps: { type: "string", default: "1" },
      label: { type: "string", default: "run" },
      out: { type: "string", default: "runs/rooms" },
      concurrency: { type: "string", default: "6" },
      "turn-timeout": { type: "string", default: "300" },
      "no-reset": { type: "boolean", default: false },
      report: { type: "string" },
    },
  });
  if (values.report) {
    // One or more run folders: a driver run's nights.json, or a session
    // run's nights/ folder with one file per night.
    const records = values.report
      .split(",")
      .flatMap((folder) =>
        existsSync(join(folder, "nights"))
          ? readdirSync(join(folder, "nights")).map(
              (name) =>
                JSON.parse(
                  readFileSync(join(folder, "nights", name), "utf8"),
                ) as NightRecord,
            )
          : (JSON.parse(
              readFileSync(join(folder, "nights.json"), "utf8"),
            ) as NightRecord[]),
      );
    console.log(report(records));
    return;
  }
  const arms = (values.arm ?? []).map((spec) => {
    const [name, runtimeId] = spec.split("=");
    if (!name || !runtimeId)
      throw new Error(`--arm takes name=<runtime-id>, got ${spec}`);
    return { name, runtimeId };
  });
  if (!arms.length)
    throw new Error("give at least one --arm name=<runtime-id>");
  const wanted = values.venues?.split(",");
  const venues = VENUES.filter((venue) =>
    wanted ? wanted.includes(venue.id) : venue.heldOut === values["held-out"],
  );
  const runId = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${values.label}`;
  const out = join(values.out!, runId);
  mkdirSync(join(out, "transcripts"), { recursive: true });
  const nights = Number(values.nights);
  const reps = Number(values.reps);
  const token = process.env.INTROSPECTION_TASK_TOKEN;
  const logs = token
    ? new IntrospectionLogs({
        token,
        serviceName: "trivia-room",
        baseOtelUrl:
          process.env.INTROSPECTION_BASE_OTEL_URL ?? "http://localhost:4318",
      })
    : undefined;
  const series = arms.flatMap((arm) =>
    venues.flatMap((venue) =>
      Array.from({ length: reps }, (_, index) => ({
        arm,
        venue,
        rep: index + 1,
      })),
    ),
  );
  console.log(`run ${runId}: ${series.length} series x ${nights} nights`);
  const records: NightRecord[] = [];
  const save = () =>
    writeFileSync(join(out, "nights.json"), JSON.stringify(records, null, 2));
  let next = 0;
  const worker = async () => {
    while (next < series.length) {
      const { arm, venue, rep } = series[next++];
      const owner = `user:${arm.name}.${venue.id}.r${rep}`;
      if (!values["no-reset"]) await resetRoom(owner);
      for (let nightNo = 1; nightNo <= nights; nightNo += 1) {
        const record = await night(
          arm.name,
          arm.runtimeId,
          venue,
          rep,
          nightNo,
          out,
          logs,
          {
            turnTimeout: Number(values["turn-timeout"]),
            runId,
          },
        );
        records.push(record);
        save();
        const rates = record.rounds.map((round) =>
          Math.round((100 * round.correct) / Math.max(1, round.answers)),
        );
        console.log(
          `${arm.name} ${venue.id} r${rep} night ${nightNo}: ${record.error ? `ERROR ${record.error}` : `rounds ${rates.join("/")}% right, ${record.turns} turns, ${record.seconds}s`}`,
        );
        if (record.error) break;
      }
    }
  };
  await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));
  await logs?.shutdown();
  save();
  writeFileSync(join(out, "report.md"), report(records));
  console.log(report(records));
  console.log(`wrote ${out}/`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
