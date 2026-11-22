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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";

import { IntrospectionLogs } from "@introspection-sdk/introspection-node/otel";

import { TARGET } from "../lib/host";
import type { RoomState } from "../lib/rooms";
import { seeded, teamAnswer, VENUES, type Venue } from "../lib/venues";
import { report } from "./scorecard";

const run = promisify(execFile);
const CLI = process.env.INTROSPECTION_BIN ?? "introspection";
const BANK = process.env.TRIVIA_BANK_URL ?? "http://localhost:3500";
const SETTLED = new Set(["awaiting_user", "idle", "completed"]);
const FAILED = new Set(["failed", "cancelled"]);
const MAX_TURNS = 16;

const TEAM_NAMES = [
  "Quizteama Aguilera",
  "The Know-It-Ales",
  "Les Quizerables",
  "Trivia Newton John",
  "Agatha Quiztie",
  "Universally Challenged",
  "The Smarty Pints",
  "Quiz Khalifa",
];

const COUNTRY = { au: "Australia", uk: "the UK", us: "the US" } as const;

/** A request for one night only: it must not reach the venue's notes. */
const TONIGHT_ONLY: Record<string, { week: number; ask: string }> = {
  "quiz-and-quill": {
    week: 2,
    ask: "It's a regular's birthday tonight and she's mad about music, so please make one round music, just for tonight.",
  },
};

const TOO_HARD = [
  "That round was brutal, half the room left it blank.",
  "Way too hard, people stopped trying.",
  "Nobody had a clue on that one.",
];
const TOO_EASY = [
  "Too easy, every table got that.",
  "Bit of a walkover, no one was stretched.",
];

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
  feedback: { round: number; rate: number; comment?: string }[];
  memory: Record<string, string>;
  seconds: number;
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

function teamsFor(venue: Venue): string[] {
  return TEAM_NAMES.slice(0, venue.teams);
}

function opening(venue: Venue, night: number): string {
  const parts = ["Start tonight's quiz."];
  if (night === 1) {
    const likes = venue.likes.join(" and ");
    parts.push(
      `We're ${venue.name.split(",")[0]} in ${venue.name.split(", ")[1]}, ${COUNTRY[venue.region]}. The crowd here loves ${likes}.`,
    );
  }
  return parts.join(" ");
}

function answerSheet(
  venue: Venue,
  state: RoomState,
  random: () => number,
): string {
  const lines = ["Here's the answer sheet for this round."];
  for (const [index, question] of state.pending.entries()) {
    lines.push("", `Question ${index + 1} (${question.id}):`);
    for (const team of state.teams) {
      const answer = teamAnswer(
        venue,
        question as Parameters<typeof teamAnswer>[1],
        random,
      );
      lines.push(`- ${team}: ${answer || "(blank)"}`);
    }
  }
  return lines.join("\n");
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
        await cli(["tasks", "prompt", taskId, "--prompt", reply]);
        task = await settle(taskId, options.turnTimeout);
        break;
      }
      await cli(["tasks", "prompt", taskId, "--prompt", reply]);
      task = await settle(taskId, options.turnTimeout);
    }
    const final = await room(owner);
    record.week = final.week;
    record.rounds = final.rounds.slice(roundsBefore);
    record.standings = final.standings;
    await sleep(5000);
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
    console.log(
      report(
        JSON.parse(readFileSync(join(values.report, "nights.json"), "utf8")),
      ),
    );
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
