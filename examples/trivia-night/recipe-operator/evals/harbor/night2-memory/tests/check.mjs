import { existsSync, readFileSync, writeFileSync } from "node:fs";

const calls = readFileSync("/logs/agent/pi.jsonl", "utf8")
  .split("\n")
  .flatMap((l) => {
    try {
      const e = JSON.parse(l);
      return e.type === "tool_execution_start"
        ? [{ name: e.toolName, args: e.args ?? {} }]
        : [];
    } catch {
      return [];
    }
  });
const text = readFileSync("/logs/agent/pi.jsonl", "utf8");
const fetches = calls.filter((c) => c.name.includes("next_questions"));
const notes = existsSync("/workspace/memories/MEMORY.md")
  ? readFileSync("/workspace/memories/MEMORY.md", "utf8")
  : "";
const scores = {
  read_notes_before_fetching: (() => {
    const r = calls.findIndex(
      (c) => c.name === "read" && String(c.args.path).endsWith("MEMORY.md"),
    );
    const f = calls.findIndex((c) => c.name.includes("next_questions"));
    return r >= 0 && f >= 0 && r < f ? 1 : 0;
  })(),
  fetched_a_round: fetches.length > 0 ? 1 : 0,
  uk_or_global_only:
    fetches.length > 0 &&
    fetches.every((c) => ["uk", "global"].includes(c.args.region))
      ? 1
      : 0,
  did_not_ask_country: /which country|what country/i.test(text) ? 0 : 1,
  notes_kept: notes.trim() && !/Quizzly|Cerebral/i.test(notes) ? 1 : 0,
};
const reward = Object.values(scores).every((v) => v === 1) ? 1 : 0;
writeFileSync(
  "/logs/verifier/reward.json",
  JSON.stringify({ reward, ...scores }),
);
console.log(
  JSON.stringify(
    { reward, ...scores, fetches: fetches.map((c) => c.args), notes },
    null,
    2,
  ),
);
