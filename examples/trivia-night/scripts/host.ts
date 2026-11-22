/**
 * Host a night in a session, not on the platform: an agent in the session
 * plays the Recipe's host, reaching the bank and the room only through this
 * command. It runs on whatever subscription the session has, with no API key.
 *
 *   pnpm -s host begin <series> --recipe <dir> --arm <a> --venue <v> --rep <r> --night <n>
 *   pnpm -s host brief <series>          the night's brief for the host agent
 *   pnpm -s host call <series> <tool> '<json>'
 *   pnpm -s host say <series> "<message to the trivia master>"
 *   pnpm -s host finish <series> --out <run-dir>
 *
 * A series folder holds one venue's memories across nights (the agent's
 * /workspace/memories) and the current night's state.
 */
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

import { TARGET } from "../lib/host";
import type { RoomState } from "../lib/rooms";
import { QUESTIONS } from "../lib/questions";
import { seeded, VENUES, type Venue } from "../lib/venues";
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
import type { NightRecord } from "./rooms";

const BANK = process.env.TRIVIA_BANK_URL ?? "http://localhost:3500";
const HERE = resolve(import.meta.dirname, "..");

interface Night {
  arm: string;
  recipe: string;
  venue: string;
  rep: number;
  night: number;
  owner: string;
  week_before: number;
  rounds_before: number;
  seen: number;
  turns: number;
  venue_asks: number;
  feedback: NightRecord["feedback"];
  started: number;
  done: boolean;
}

const nightFile = (series: string) => join(series, "night.json");
const readNight = (series: string): Night =>
  JSON.parse(readFileSync(nightFile(series), "utf8"));
const writeNight = (series: string, night: Night) =>
  writeFileSync(nightFile(series), JSON.stringify(night, null, 2));
const memories = (series: string) => resolve(series, "memories");
const venueOf = (night: Night): Venue =>
  VENUES.find((venue) => venue.id === night.venue)!;

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ");

/** The pending questions the host's message reads out to the room. */
function readOut(message: string, state: RoomState): RoomState["pending"] {
  const said = squash(message);
  return state.pending.filter((pending) => {
    const text = QUESTIONS.find((item) => item.id === pending.id)?.text ?? "";
    return said.includes(squash(text).trim().slice(0, 30));
  });
}

async function room(owner: string): Promise<RoomState> {
  const response = await fetch(
    `${BANK}/api/rooms?owner=${encodeURIComponent(owner)}`,
  );
  if (!response.ok) throw new Error(`rooms API answered ${response.status}`);
  return (await response.json()) as RoomState;
}

/** One MCP request to the bank, as the venue. */
async function mcp(
  owner: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const post = (body: unknown, session?: string) =>
    fetch(`${BANK}/bank/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-trivia-owner": owner,
        ...(session && { "mcp-session-id": session }),
      },
      body: JSON.stringify(body),
    });
  const opened = await post({ jsonrpc: "2.0", id: 1, method: "initialize" });
  const session = opened.headers.get("mcp-session-id") ?? "";
  const response = await post(
    { jsonrpc: "2.0", id: 2, method, params },
    session,
  );
  const text = await response.text();
  const data = text.includes("data: ") ? text.split("data: ")[1] : text;
  return JSON.parse(data);
}

function args(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1)
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[(i += 1)];
  return out;
}

async function begin(series: string, flags: Record<string, string>) {
  const venue = VENUES.find((item) => item.id === flags.venue);
  if (!venue) throw new Error(`unknown venue ${flags.venue}`);
  const nightNo = Number(flags.night);
  const owner = `user:${flags.arm}.${venue.id}.r${flags.rep}`;
  mkdirSync(memories(series), { recursive: true });
  if (nightNo === 1) {
    rmSync(memories(series), { recursive: true, force: true });
    mkdirSync(memories(series), { recursive: true });
    await fetch(`${BANK}/api/rooms?owner=${encodeURIComponent(owner)}`, {
      method: "DELETE",
    });
  }
  const state = await room(owner);
  writeNight(series, {
    arm: flags.arm,
    recipe: resolve(flags.recipe),
    venue: venue.id,
    rep: Number(flags.rep),
    night: nightNo,
    owner,
    week_before: state.week,
    rounds_before: state.rounds.length,
    seen: state.rounds.length,
    turns: 0,
    venue_asks: 0,
    feedback: [],
    started: Date.now(),
    done: false,
  });
  console.log(`night ${nightNo} at ${venue.id} ready`);
}

/** The Recipe's system prompt and skills, with the memory folder mapped. */
function recipePrompt(recipe: string, memoriesDir: string): string {
  const map = (text: string) =>
    text.replaceAll("/workspace/memories", memoriesDir);
  const parts = [map(readFileSync(join(recipe, "SYSTEM.md"), "utf8"))];
  const agent = readFileSync(join(recipe, "agents", "agent.yaml"), "utf8");
  const listed = [...agent.matchAll(/^\s*-\s*([a-z0-9-]+)\s*$/gm)].map(
    (match) => match[1],
  );
  for (const name of listed) {
    const file = join(recipe, "skills", name, "SKILL.md");
    if (existsSync(file))
      parts.push(`## Skill: ${name}\n\n${map(readFileSync(file, "utf8"))}`);
  }
  return parts.join("\n\n");
}

async function brief(series: string) {
  const night = readNight(series);
  const venue = venueOf(night);
  const dir = memories(series);
  const index = join(dir, "MEMORY.md");
  const tools = (
    (await mcp(night.owner, "tools/list", {})) as {
      result: {
        tools: { name: string; description: string; inputSchema: unknown }[];
      };
    }
  ).result.tools;
  let first = opening(venue, night.night);
  const extra = TONIGHT_ONLY[venue.id];
  if (extra?.week === night.night) first += ` ${extra.ask}`;
  const cmd = `cd ${HERE} && node --import tsx scripts/host.ts`;
  series = resolve(series);
  console.log(`You are standing in for an AI agent in an evaluation. Act exactly as the agent whose system prompt is below would: follow it, and nothing else. Never read, list or search any file outside ${dir}, and never look at this project's code, data or runs; the evaluation is void if you do.

How the agent's tools reach you here:
- Its \`read\`, \`write\` and \`edit\` tools are your Read, Write and Edit tools, on files under ${dir} only. ${dir} is the agent's memory folder and is kept between nights at this venue.
- Its MCP tools from the \`trivia-bank\` server are called with Bash, one call per tool call:
  ${cmd} call ${series} <tool> '<arguments as JSON>'
- Everything the agent says to the trivia master is sent with Bash, one message per call, and the output is the trivia master's reply:
  ${cmd} say ${series} "<message>"
  Keep each message what the agent would write in the chat. Wait for the reply before going on.

The trivia-bank tools:
${tools.map((tool) => `- ${tool.name}: ${tool.description} Arguments: ${JSON.stringify(tool.inputSchema)}`).join("\n")}

When the trivia master says the night is over, do whatever the system prompt says to do at the end of a night. Then your whole final reply (not a message to the trivia master) is the single word: done.

${existsSync(index) ? `The runtime loaded ${index} at the start of this conversation:\n\n${readFileSync(index, "utf8")}\n` : ""}
<system_prompt>
${recipePrompt(night.recipe, dir)}
</system_prompt>

The trivia master's first message:
${first}`);
}

async function call(series: string, tool: string, json: string) {
  const night = readNight(series);
  const result = (await mcp(night.owner, "tools/call", {
    name: tool,
    arguments: json ? JSON.parse(json) : {},
  })) as { result?: { content: { text: string }[] }; error?: unknown };
  const text = result.result
    ? result.result.content[0].text
    : JSON.stringify(result.error);
  log(series, night, { kind: "tool", tool, arguments: json, result: text });
  console.log(text);
}

/** One line of the night's trajectory, for the meta agent to read. */
function log(series: string, night: Night, entry: Record<string, unknown>) {
  appendFileSync(
    join(series, `trajectory-${night.night}.jsonl`),
    `${JSON.stringify(entry)}\n`,
  );
}

async function say(series: string, message: string) {
  const night = readNight(series);
  const venue = venueOf(night);
  const state = await room(night.owner);
  night.turns += 1;
  for (const [index, round] of state.rounds.slice(night.seen).entries()) {
    const rate = round.answers ? round.correct / round.answers : 0;
    if (rate < TARGET.low || rate > TARGET.high) {
      const pick = seeded(
        night.rep * 31 + night.night * 7 + night.seen + index,
      );
      const comment =
        pick() < 0.4
          ? (rate < TARGET.low ? TOO_HARD : TOO_EASY)[Math.floor(pick() * 2)]
          : undefined;
      night.feedback.push({
        round: night.seen - night.rounds_before + index + 1,
        rate,
        comment,
      });
    }
  }
  night.seen = state.rounds.length;
  const tonight = state.rounds.filter((round) => round.week === state.week);
  const asked = !state.pending.length && ASKS_ABOUT_VENUE.test(message);
  if (asked) night.venue_asks += 1;
  const about = asked ? `${describe(venue)} ` : "";
  let reply: string;
  if (state.week <= night.week_before)
    reply = "Please start tonight's night with the bank before anything else.";
  else if (!state.teams.length)
    reply = `${about}Tonight's teams: ${teamsFor(venue).join(", ")}.`;
  else if (tonight.length >= 3) {
    // Questions fetched and never read out don't hold the night open.
    reply = night.done
      ? "The night is over. Do what you do at the end of a night, then reply done."
      : "Thanks, that's the night. See you next week.";
    night.done = true;
  } else if (state.pending.length && !readOut(message, state).length) {
    reply = `${about}Ready when you are: give me the round to read out.`;
  } else if (state.pending.length) {
    const random = seeded(
      1000 * night.rep +
        17 * night.night +
        101 * tonight.length +
        venue.id.length,
    );
    reply = answerSheet(
      venue,
      { ...state, pending: readOut(message, state) },
      random,
    );
  } else reply = `${about}Sounds good, go ahead.`;
  log(series, night, { kind: "host", message });
  log(series, night, { kind: "trivia_master", message: reply });
  writeNight(series, night);
  console.log(reply);
}

function snapshot(dir: string, into: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(dir, path)] = readFileSync(path, "utf8");
    }
  };
  walk(dir);
  mkdirSync(into, { recursive: true });
  cpSync(dir, into, { recursive: true });
  return out;
}

async function finish(series: string, flags: Record<string, string>) {
  const night = readNight(series);
  const state = await room(night.owner);
  const userId = night.owner.replace(/^user:/, "");
  const record: NightRecord = {
    arm: night.arm,
    runtime_id: night.recipe,
    venue: night.venue,
    held_out: venueOf(night).heldOut,
    rep: night.rep,
    night: night.night,
    user_id: userId,
    week: state.week,
    rounds: state.rounds.slice(night.rounds_before),
    standings: state.standings,
    turns: night.turns,
    venue_asks: night.venue_asks,
    feedback: night.feedback,
    memory: snapshot(
      memories(series),
      join(flags.out, "memory", userId, `night-${night.night}`),
    ),
    seconds: Math.round((Date.now() - night.started) / 1000),
    ...(state.rounds.length - night.rounds_before < 3 && {
      error: `only ${state.rounds.length - night.rounds_before} rounds submitted`,
    }),
  };
  mkdirSync(join(flags.out, "nights"), { recursive: true });
  const trajectory = join(series, `trajectory-${night.night}.jsonl`);
  if (existsSync(trajectory)) {
    mkdirSync(join(flags.out, "trajectories"), { recursive: true });
    cpSync(
      trajectory,
      join(flags.out, "trajectories", `${userId}-n${night.night}.jsonl`),
    );
  }
  writeFileSync(
    join(flags.out, "nights", `${userId}-n${night.night}.json`),
    JSON.stringify(record, null, 2),
  );
  const rates = record.rounds.map((round) =>
    Math.round((100 * round.correct) / Math.max(1, round.answers)),
  );
  console.log(
    `${night.arm} ${night.venue} r${night.rep} night ${night.night}: rounds ${rates.join("/")}% right, ${record.turns} turns${record.error ? `, ${record.error}` : ""}`,
  );
}

const [command, series, ...rest] = process.argv.slice(2);
const commands: Record<string, () => Promise<void>> = {
  begin: () => begin(series, args(rest)),
  brief: () => brief(series),
  call: () => call(series, rest[0], rest[1] ?? ""),
  say: () => say(series, rest.join(" ")),
  finish: () => finish(series, args(rest)),
};
if (!commands[command] || !series) {
  console.error("usage: host begin|brief|call|say|finish <series> ...");
  process.exit(2);
}
commands[command]().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
