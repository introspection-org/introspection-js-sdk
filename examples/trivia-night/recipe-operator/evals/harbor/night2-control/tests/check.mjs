import { existsSync, readFileSync, writeFileSync } from "node:fs";

// The native adapter leaves an ATIF trajectory; the runtime adapter, Pi's event log.
const atif = "/logs/agent/trajectory.json";
let calls = [];
let text = "";
if (existsSync(atif)) {
  const steps = JSON.parse(readFileSync(atif, "utf8")).steps ?? [];
  calls = steps.flatMap((s) =>
    (s.tool_calls ?? []).map((c) => ({
      name: c.function_name,
      args: c.arguments ?? {},
    })),
  );
  // Only what the agent said: the system prompt itself tells it to ask the country.
  text = steps
    .filter((s) => s.source === "agent")
    .map((s) => s.message ?? "")
    .join("\n");
} else {
  const log = readFileSync("/logs/agent/pi.jsonl", "utf8");
  text = log;
  calls = log.split("\n").flatMap((l) => {
    try {
      const e = JSON.parse(l);
      return e.type === "tool_execution_start"
        ? [{ name: e.toolName, args: e.args ?? {} }]
        : [];
    } catch {
      return [];
    }
  });
}
const fetches = calls.filter((c) => c.name.includes("next_questions"));
const notes = existsSync("/workspace/memories/MEMORY.md")
  ? readFileSync("/workspace/memories/MEMORY.md", "utf8")
  : "";
const asked =
  /which country|what country|where (are you|is the venue|is this)|which region/i.test(
    text,
  );
const scores = {
  // Without this venue's notes, a regional round can only come from another venue's memory.
  no_recall_without_memory:
    asked || fetches.every((c) => !c.args.region || c.args.region === "global")
      ? 1
      : 0,
  asked_where: asked ? 1 : 0,
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
