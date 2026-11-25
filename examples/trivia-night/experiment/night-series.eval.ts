// One pub's two-night series for one candidate Recipe: night 1 writes the
// notes, a fresh session plays night 2 from them, and the platform's own
// verifier (evals/trivia-check.mjs) scores night 2 from the bank's state.
// Run from the candidate's directory: PUB, EVIDENCE_DIR and ARM
// (hosted = its own notes, fresh = an empty memories folder on night 2).
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
const evidence = process.env.EVIDENCE_DIR!;
const arm = process.env.ARM ?? "hosted";
const recipe = process.cwd();

const { fakes } = await import(
  pathToFileURL(join(recipe, "fakes/mcp/index.ts")).href
);
const { world } = await import(
  pathToFileURL(join(recipe, "fakes/scenarios/index.ts")).href
);
// The candidate's own task module and verifier, as its dynamic tasks run them.
const tasks = await import(
  pathToFileURL(join(recipe, "evals/trivia-tasks.mjs")).href
);
const { check } = await import(
  pathToFileURL(join(recipe, "evals/trivia-check.mjs")).href
);
const venue = tasks.venueNamed(
  ["venues.json", "heldout.json"].map((file) =>
    JSON.parse(readFileSync(join(recipe, "evals", file), "utf8")),
  ),
  pub,
);
const scenario = venue.profile as string;

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

async function score(
  state: unknown,
  memories: string,
  out: string,
): Promise<Record<string, unknown>> {
  mkdirSync(out, { recursive: true });
  // Every measure, raw counts included, from the report, as the page reads it;
  // reward.json keeps only those in [0, 1].
  const { report } = await check({
    night: 2,
    expected: tasks.expectedFor(venue, 2),
    bank: state,
    memories,
    env: { ...process.env, LOGS_DIR: out },
  });
  writeFileSync(join(out, "report.json"), JSON.stringify(report));
  return report;
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
        (tasks.instructionFor(venue, night) as string).trim();

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
      const measures = await score(
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
