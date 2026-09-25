// A real run on en.wikipedia.org, replayed without the network for each driver.
// fixtures/wikipedia-chromium.json holds the observations a live Jev run saw
// (from the page script, handles renamed per page) and the decision Jev made at
// each step; each driver's recording holds its answers to exactly those
// requests, with credentials redacted by polly-setup.
//
// Refresh the fixture, then re-record every driver:
//   node browser-agent/capture-wikipedia.mjs browser-agent/fixtures/wikipedia-chromium.json
//   POLLY_MODE=record TYPESAFE_API_KEY=… ANTHROPIC_API_KEY=… OPENAI_API_KEY=… \
//     vitest run browser-agent/test-browser-jev-trajectory
// A driver whose recording is absent is skipped in replay.
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Polly } from "@pollyjs/core";
import {
  ClaudeDriver,
  DECISION_OPS,
  JevDriver,
  OpenAICompatibleDriver,
  renderTable,
  type Decision,
  type Driver,
  type Observation,
  type StepRecord,
} from "@introspection-sdk/browser-agent";
import {
  ensureEnvVarsForReplay,
  pollyEndpoints,
  setupPolly,
} from "../polly-setup";

interface Trajectory {
  goal: string;
  slots: Record<string, string>;
  steps: {
    observation: Observation;
    history: Pick<StepRecord, "op" | "element" | "text">[];
    decision: Pick<Decision, "op" | "element" | "text" | "keys">;
    error?: string;
  }[];
}

const TRAJECTORY = JSON.parse(
  readFileSync(
    new URL("./fixtures/wikipedia-chromium.json", import.meta.url),
    "utf8",
  ),
) as Trajectory;

// Pinned: the model is part of the recorded request body.
const OPENAI_MODEL = "gpt-5-mini";

const decide = (driver: Driver, i: number) => {
  const step = TRAJECTORY.steps[i]!;
  return driver.decide({
    goal: TRAJECTORY.goal,
    observation: step.observation,
    table: renderTable(step.observation),
    history: step.history as StepRecord[],
    step: i,
  });
};

/** A decision is sound when it acts on an element this page offers it for. */
function expectSound(d: Decision, observation: Observation) {
  expect(DECISION_OPS).toContain(d.op);
  if (d.op === "click" || d.op === "type" || d.op === "select") {
    const row = observation.elements.find((e) => e.element === d.element);
    expect(row, `${d.op} on ${d.element}`).toBeDefined();
    expect(row!.actions).toContain(d.op);
  }
}

function recorded(name: string, envVars: string[]): { active: () => boolean } {
  let polly: Polly | null = null;
  beforeAll(() => {
    polly = setupPolly({ recordingName: name, adapters: ["fetch"] });
    if (!ensureEnvVarsForReplay(envVars, name)) {
      console.log(`Skipping ${name}: no recording, or keys missing to record`);
      void polly.stop();
      polly = null;
    }
  });
  afterAll(async () => {
    await polly?.stop();
  });
  return { active: () => polly !== null };
}

describe("JevDriver on a real Wikipedia trajectory (recorded)", () => {
  const polly = recorded("browser-agent-jev-wikipedia", ["TYPESAFE_API_KEY"]);

  it.each(TRAJECTORY.steps.map((step, i) => [i, step] as const))(
    "step %i makes the decision the live run made",
    async (i, step) => {
      if (!polly.active()) return;
      const d = await new JevDriver({
        apiKey: process.env.TYPESAFE_API_KEY,
        baseUrl: pollyEndpoints.typesafe.base,
        slots: TRAJECTORY.slots,
      }).decide({
        goal: TRAJECTORY.goal,
        observation: step.observation,
        table: "",
        history: step.history as StepRecord[],
        step: i,
      });
      expect({
        op: d.op,
        element: d.element,
        text: d.text,
        keys: d.keys,
      }).toEqual(step.decision);
    },
  );

  it("documents the autocomplete re-render that made a handle stale", () => {
    const stale = TRAJECTORY.steps.findIndex((s) => s.error);
    expect(TRAJECTORY.steps[stale]!.error).toMatch(/^stale/);
    // The loop recovered on the next observation of the same document.
    expect(TRAJECTORY.steps[stale + 1]!.decision.op).toBe("click");
    expect(TRAJECTORY.steps.at(-1)!.observation.url).toBe(
      "https://en.wikipedia.org/wiki/Chromium",
    );
  });
});

// A frontier model may take a different valid path than Jev (Enter instead of
// the button, the suggestion instead of the result), so these assert that each
// decision is sound and that the ends of the flow are right.
describe.each([
  {
    name: "ClaudeDriver",
    recording: "browser-agent-claude-wikipedia",
    envVars: ["ANTHROPIC_API_KEY"],
    driver: (): Driver =>
      new ClaudeDriver({
        client: new Anthropic({
          apiKey: process.env.ANTHROPIC_API_KEY,
          baseURL: pollyEndpoints.anthropic.node,
        }) as never,
      }),
  },
  {
    name: "OpenAICompatibleDriver",
    recording: "browser-agent-openai-wikipedia",
    envVars: ["OPENAI_API_KEY"],
    driver: (): Driver =>
      new OpenAICompatibleDriver({
        model: OPENAI_MODEL,
        apiKey: process.env.OPENAI_API_KEY,
        baseUrl: pollyEndpoints.openai.v1,
      }),
  },
])("$name on a real Wikipedia trajectory (recorded)", (c) => {
  const polly = recorded(c.recording, c.envVars);
  const last = TRAJECTORY.steps.length - 1;

  it("types the search into Wikipedia's search box first", async () => {
    if (!polly.active()) return;
    const d = await decide(c.driver(), 0);
    expectSound(d, TRAJECTORY.steps[0]!.observation);
    expect(d.op).toBe("type");
    expect(d.text).toMatch(/chromium/i);
    const row = TRAJECTORY.steps[0]!.observation.elements.find(
      (e) => e.element === d.element,
    );
    expect(row?.role).toMatch(/searchbox|combobox/);
  });

  it.each(TRAJECTORY.steps.slice(1, -1).map((_, i) => [i + 1] as const))(
    "submits or picks a result at step %i",
    async (i) => {
      if (!polly.active()) return;
      const d = await decide(c.driver(), i);
      expectSound(d, TRAJECTORY.steps[i]!.observation);
      expect(["click", "press"]).toContain(d.op);
    },
  );

  it("reports done on the Chromium article", async () => {
    if (!polly.active()) return;
    const d = await decide(c.driver(), last);
    expect(d.op).toBe("done");
  });
});
