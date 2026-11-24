import { existsSync, readFileSync, writeFileSync } from "node:fs";

const expected = JSON.parse(readFileSync(new URL("./expected.json", import.meta.url), "utf8"));
const state = await (await fetch("http://fakes:7353/trivia-bank/admin/state")).json();
const bank = state["trivia-bank"] ?? state;
const notesPath = "/workspace/memories/MEMORY.md";
const notes = existsSync(notesPath) ? readFileSync(notesPath, "utf8") : "";
const teams = expected.teams.map((t) => t.replace(/^the\s+/i, "").toLowerCase());
const scores = {
  night_started: (bank.nights?.length ?? 0) === 1 ? 1 : 0,
  round_fetched: (bank.asked?.length ?? 0) > 0 ? 1 : 0,
  notes_written: notes.trim() ? 1 : 0,
  notes_name_no_team: notes && !teams.some((t) => notes.toLowerCase().includes(t)) ? 1 : 0,
};
const reward = Object.values(scores).every((v) => v === 1) ? 1 : 0;
writeFileSync("/logs/verifier/reward.json", JSON.stringify({ reward, ...scores }));
console.log(JSON.stringify({ reward, ...scores, notes }, null, 2));
