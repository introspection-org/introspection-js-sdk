import { existsSync, readFileSync, writeFileSync } from "node:fs";

const expected = JSON.parse(readFileSync(new URL("./expected.json", import.meta.url), "utf8"));
// The native adapter leaves an ATIF trajectory; the runtime adapter, Pi's event log.
const atif = "/logs/agent/trajectory.json";
let calls = [];
let text = "";
if (existsSync(atif)) {
  const steps = JSON.parse(readFileSync(atif, "utf8")).steps ?? [];
  calls = steps.flatMap((s) => (s.tool_calls ?? []).map((c) => ({ name: c.function_name, args: c.arguments ?? {} })));
  // Only what the agent said: the system prompt itself tells it to ask the country.
  text = steps.filter((s) => s.source === "agent").map((s) => s.message ?? "").join("\n");
} else {
  const log = readFileSync("/logs/agent/pi.jsonl", "utf8");
  text = log;
  calls = log.split("\n").flatMap((l) => {
    try {
      const e = JSON.parse(l);
      return e.type === "tool_execution_start" ? [{ name: e.toolName, args: e.args ?? {} }] : [];
    } catch { return []; }
  });
}
const fetches = calls.filter((c) => c.name.includes("next_questions"));
const notes = existsSync("/workspace/memories/MEMORY.md") ? readFileSync("/workspace/memories/MEMORY.md", "utf8") : "";
const teams = expected.teams.map((t) => t.replace(/^the\s+/i, "").toLowerCase());
const scores = {
  fetched_a_round: fetches.length > 0 ? 1 : 0,
  own_region_or_global_only: fetches.length > 0 && fetches.every((c) => [expected.region, "global"].includes(c.args.region)) ? 1 : 0,
  did_not_ask_country: /which country|what country/i.test(text) ? 0 : 1,
  notes_kept: notes.trim() && !teams.some((t) => notes.toLowerCase().includes(t)) ? 1 : 0,
};
const reward = Object.values(scores).every((v) => v === 1) ? 1 : 0;
writeFileSync("/logs/verifier/reward.json", JSON.stringify({ reward, ...scores }));
console.log(JSON.stringify({ reward, ...scores, expected_region: expected.region, fetches: fetches.map((c) => c.args), notes }, null, 2));
