// A real Jev trajectory on en.wikipedia.org, replayed without the network.
// fixtures/wikipedia-chromium.json holds the observations a live run saw (from
// the page script, handles renamed per page) and the decision Jev made at each
// step; the recording holds Jev's answers to exactly those requests.
//
// Refresh both together, with network access to the site and TypeSafe:
//   node browser-agent/capture-wikipedia.mjs browser-agent/fixtures/wikipedia-chromium.json
//   POLLY_MODE=record TYPESAFE_API_KEY=… vitest run browser-agent/test-browser-jev-trajectory
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Polly } from "@pollyjs/core";
import {
  JevDriver,
  type Decision,
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

describe("JevDriver on a real Wikipedia trajectory (recorded)", () => {
  let polly: Polly | null = null;

  beforeAll(() => {
    polly = setupPolly({
      recordingName: "browser-agent-jev-wikipedia",
      adapters: ["fetch"],
    });
    if (
      !ensureEnvVarsForReplay(
        ["TYPESAFE_API_KEY"],
        "browser-agent-jev-wikipedia",
      )
    ) {
      console.log("Skipping: TYPESAFE_API_KEY missing for record/passthrough");
      void polly.stop();
      polly = null;
    }
  });
  afterAll(async () => {
    await polly?.stop();
  });

  it.each(TRAJECTORY.steps.map((step, i) => [i, step] as const))(
    "step %i makes the decision the live run made",
    async (i, step) => {
      if (!polly) return;
      const driver = new JevDriver({
        apiKey: process.env.TYPESAFE_API_KEY,
        baseUrl: pollyEndpoints.typesafe.base,
        slots: TRAJECTORY.slots,
      });
      const d = await driver.decide({
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
      const row = step.observation.elements.find(
        (e) => e.element === d.element,
      );
      if (d.op === "type") expect(row?.role).toBe("searchbox");
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
