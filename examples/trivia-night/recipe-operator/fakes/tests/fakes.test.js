import { test } from "node:test";
import { checkRecipeFakes } from "@introspection-ai/eval-simulate/mcp/checks";
import { fakes } from "../mcp/index.ts";
import { SCENARIOS, world } from "../scenarios/index.ts";
import { RECORD } from "./client.js";

checkRecipeFakes({
  test,
  recipe: new URL("../../package.json", import.meta.url),
  fakes,
  world,
  scenarios: SCENARIOS,
  recording: RECORD,
  consistent: (w) => {
    const bank = w["trivia-bank"];
    const ids = new Set(bank.questions.map((q) => q.id));
    if (ids.size !== bank.questions.length)
      throw new Error("duplicate question ids");
    for (const a of bank.asked)
      if (!ids.has(a.question_id))
        throw new Error(`asked ${a.question_id} is not in the supply`);
    for (const m of bank.marks)
      if (!ids.has(m.question_id))
        throw new Error(`mark for ${m.question_id} is not in the supply`);
  },
});
