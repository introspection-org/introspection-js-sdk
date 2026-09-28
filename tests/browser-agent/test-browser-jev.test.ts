import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Polly } from "@pollyjs/core";
import {
  JevDriver,
  summarizeHead,
  type Observation,
  type StepInput,
} from "@introspection-sdk/browser-agent";
import {
  ensureEnvVarsForReplay,
  pollyEndpoints,
  setupPolly,
} from "../polly-setup";

// A fixed observation, because Polly matches request bodies and live element
// handles carry a random per-document token.
const OBSERVATION: Observation = {
  version: "browser.v1",
  tab_id: "t1",
  url: "http://127.0.0.1/stays",
  title: "Stays",
  text: "Destination Category All Design Nature Free cancellation Search no search yet",
  scroll: { y: 0, height: 1800, viewport: 600 },
  elements: [
    {
      element: "el_fix_1",
      role: "searchbox",
      name: "Destination",
      value: "",
      actions: ["type", "click"],
    },
    {
      element: "el_fix_2",
      role: "select",
      name: "Category",
      value: "All",
      options: ["All", "Design", "Nature"],
      actions: ["select"],
    },
    {
      element: "el_fix_3",
      role: "checkbox",
      name: "Free cancellation",
      checked: false,
      actions: ["click"],
    },
    { element: "el_fix_4", role: "button", name: "Search", actions: ["click"] },
    {
      element: "el_fix_5",
      role: "button",
      name: "Disabled action",
      disabled: true,
      actions: ["click"],
    },
  ],
  next_cursor: null,
};

const input = (goal: string, observation = OBSERVATION): StepInput => ({
  goal,
  observation,
  table: "",
  history: [],
  step: 0,
});

describe("summarizeHead", () => {
  it("ranks choices and measures the top-two margin", () => {
    const s = summarizeHead({
      choice: "a",
      confidence: 0.7,
      probabilities: { a: 0.6, b: 0.3, c: 0.1 },
    });
    expect(s).toMatchObject({
      choice: "a",
      confidence: 0.7,
      top: [
        { choice: "a", p: 0.6 },
        { choice: "b", p: 0.3 },
        { choice: "c", p: 0.1 },
      ],
    });
    expect(s.margin).toBeCloseTo(0.3);
    expect(
      summarizeHead({ choice: "a", confidence: 1, probabilities: { a: 1 } })
        .margin,
    ).toBe(1);
  });
});

describe("JevDriver (recorded)", () => {
  let polly: Polly | null = null;

  beforeAll(() => {
    polly = setupPolly({
      recordingName: "browser-agent-jev",
      adapters: ["fetch"],
    });
    if (!ensureEnvVarsForReplay(["TYPESAFE_API_KEY"], "browser-agent-jev")) {
      console.log("Skipping: TYPESAFE_API_KEY missing for record/passthrough");
      void polly.stop();
      polly = null;
    }
  });
  afterAll(async () => {
    await polly?.stop();
  });

  const driver = (
    over: Partial<ConstructorParameters<typeof JevDriver>[0]> = {},
  ) =>
    new JevDriver({
      apiKey: process.env.TYPESAFE_API_KEY,
      baseUrl: pollyEndpoints.typesafe.base,
      ...over,
    });

  it("types a value from slots into the field it picks, with a confidence signal", async () => {
    if (!polly) return;
    const d = await driver({ slots: { destination: "Lisbon" } }).decide(
      input("Find Design stays in Lisbon."),
    );
    expect(d).toMatchObject({
      op: "type",
      element: "el_fix_1",
      text: "Lisbon",
    });
    expect(d.signal?.op.choice).toBe("TYPE_TEXT");
    expect(d.signal?.target?.choice).toBe("el_fix_1");
    expect(d.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("maps a select head back to the element and option label", async () => {
    if (!polly) return;
    const filled: Observation = {
      ...OBSERVATION,
      elements: OBSERVATION.elements.map((e) =>
        e.element === "el_fix_1" ? { ...e, value: "Lisbon" } : e,
      ),
    };
    const d = await driver().decide(
      input("Find Design stays in Lisbon.", filled),
    );
    expect(d).toMatchObject({
      op: "select",
      element: "el_fix_2",
      text: "Design",
    });
  });

  it("blocks rather than inventing a value nobody supplied", async () => {
    if (!polly) return;
    const d = await driver().decide(input("Find Design stays in Lisbon."));
    expect(d).toMatchObject({ op: "blocked" });
    expect(d.reason).toMatch(/does not say what to type into "Destination"/);
  });

  it("asks a text driver when one is configured", async () => {
    if (!polly) return;
    const d = await driver({
      textDriver: {
        writeText: async (field) =>
          field.name === "Destination" ? "Lisbon" : "",
      },
    }).decide(input("Find Design stays in Lisbon."));
    expect(d).toMatchObject({ op: "type", text: "Lisbon" });
  });

  it("surfaces an HTTP failure", async () => {
    if (!polly) return;
    await expect(
      driver({
        apiKey: "invalid",
        baseUrl: "https://api.typesafe.ai/nope",
      }).decide(input("x")),
    ).rejects.toThrow(/HTTP/);
  });
});
