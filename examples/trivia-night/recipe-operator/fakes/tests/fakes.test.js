import { test } from "node:test";
import { checkRecipeFakes } from "@introspection-ai/eval-simulate/mcp/checks";
import { recipeFakes as fakes } from "../mcp/index.ts";
import { SCENARIOS, world } from "../scenarios/index.ts";

checkRecipeFakes({
  test,
  recipe: new URL("../../package.json", import.meta.url),
  fakes,
  world,
  scenarios: Object.keys(SCENARIOS),
  recording: new URL("./responses.jsonl", import.meta.url).pathname,
  consistent: (w) => {
    const bank = w["question-bank"];
    for (const [cell, n] of Object.entries(bank.supply))
      if (!Number.isInteger(n) || n < 0) throw new Error(`bad supply ${cell}`);
    if (bank.asked.length) throw new Error("a world starts with nothing asked");
  },
});
