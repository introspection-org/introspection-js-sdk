// One pub's two-night series for one candidate Recipe: night 1 writes the
// notes, a fresh session plays night 2 from them, and the platform's own
// verifier (night2-<pub>/tests/check.mjs) scores night 2 from the bank's state.
// Run from the candidate's directory: PUB, TASKS_DIR, EVIDENCE_DIR and ARM
// (hosted = its own notes, fresh = an empty memories folder on night 2).
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { createRecipeHarness } from "@introspection-ai/vitest-evals";
import { startServices } from "@introspection-ai/eval-simulate/mcp";

const pub = process.env.PUB!;
const tasks = process.env.TASKS_DIR!;
const evidence = process.env.EVIDENCE_DIR!;
const arm = process.env.ARM ?? "hosted";
const recipe = process.cwd();

const { fakes } = await import(
  pathToFileURL(join(recipe, "fakes/mcp/index.ts")).href
);
const { world } = await import(
  pathToFileURL(join(recipe, "fakes/scenarios/index.ts")).href
);
const scenario = JSON.parse(
  readFileSync(join(tasks, `night1-${pub}/tests/expected.json`), "utf8"),
).venue as string;

type Input = { prompt: string; night: 1 | 2; memories: string };
type Services = Awaited<ReturnType<typeof startServices>>;

const harness = createRecipeHarness<Input, Services>({
  beforeRun: async ({ input }) => {
    // world() reads the night from the environment; one pub runs per process.
    process.env.EVAL_SIMULATE_NIGHT = String(input.night);
    process.env.EVAL_SIMULATE_SERIES_NIGHTS = "2";
    process.env.EVAL_SIMULATE_TEAMS = "5";
    const services = await startServices(fakes, {
      world,
      scenario: `crowd-${scenario}`,
    });
    return {
      mcpServers: services.mcpServers(),
      workspaceDirectories: { memories: input.memories },
      fixture: services,
      teardown: services.close,
    };
  },
  collectArtifacts: ({ fixture }) => ({ bank: fixture.states }),
});

function score(
  state: unknown,
  memories: string,
  out: string,
): Record<string, unknown> {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "state.json"), JSON.stringify(state));
  const check = readFileSync(
    join(tasks, `night2-${pub}/tests/check.mjs`),
    "utf8",
  )
    .replace(
      /await \(\s*await fetch\("http:\/\/fakes:7353\/trivia-bank\/admin\/state"\)\s*\)\.json\(\)/,
      `JSON.parse(readFileSync(${JSON.stringify(join(out, "state.json"))}, "utf8"))`,
    )
    .replace('"/workspace/memories"', JSON.stringify(memories))
    .replace(
      '"/logs/verifier/reward.json"',
      JSON.stringify(join(out, "reward.json")),
    )
    .replace(
      '"/logs/verifier/result.json"',
      JSON.stringify(join(out, "result.json")),
    );
  copyFileSync(
    join(tasks, `night2-${pub}/tests/expected.json`),
    join(out, "expected.json"),
  );
  writeFileSync(join(out, "check.mjs"), check);
  const report = execFileSync(process.execPath, [join(out, "check.mjs")], {
    encoding: "utf8",
  });
  writeFileSync(join(out, "report.json"), report);
  // Every measure, raw counts included; reward.json keeps only those in [0, 1].
  return JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
}

describeEval(
  `trivia series ${pub} ${arm}`,
  { harness, judgeThreshold: null },
  (it) => {
    it(`${pub} ${arm}`, async ({ run }) => {
      const dir = join(evidence, pub, arm);
      const memories = join(dir, "memories");
      mkdirSync(memories, { recursive: true });
      const instruction = (night: 1 | 2) =>
        readFileSync(
          join(tasks, `night${night}-${pub}/instruction.md`),
          "utf8",
        ).trim();

      let night1Memories = memories;
      if (arm === "fresh") night1Memories = join(dir, "night1-memories");
      mkdirSync(night1Memories, { recursive: true });
      const first = await run({
        prompt: instruction(1),
        night: 1,
        memories: night1Memories,
      });
      writeFileSync(join(dir, "night1.json"), JSON.stringify(first, null, 1));
      const written = join(night1Memories, "MEMORY.md");
      if (existsSync(written))
        copyFileSync(written, join(dir, "night1-MEMORY.md"));

      const second = await run({ prompt: instruction(2), night: 2, memories });
      writeFileSync(join(dir, "night2.json"), JSON.stringify(second, null, 1));
      const measures = score(
        second.artifacts?.bank,
        memories,
        join(dir, "score"),
      );
      writeFileSync(
        join(dir, "measures.json"),
        JSON.stringify(measures, null, 1),
      );
      expect(typeof measures.good_rounds).toBe("number");
    });
  },
);
