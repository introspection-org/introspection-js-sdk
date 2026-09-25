// JevDriver's decision contract, against a scripted TypeSafe endpoint: what it
// offers, what it refuses, and how it recovers. The recorded suites cover the
// real model; these pin the rules jev-ultrafast taught us.
import { describe, expect, it } from "vitest";
import {
  JevDriver,
  validateAnswer,
  type Observation,
  type StepInput,
  type StepRecord,
} from "@introspection-sdk/browser-agent";
import { fakeJev } from "./jev-fake";

const page = (over: Partial<Observation> = {}): Observation => ({
  version: "browser.v1",
  tab_id: "t",
  url: "https://shop.test/",
  title: "Shop",
  text: "",
  scroll: { y: 0, height: 600, viewport: 600 },
  elements: [
    {
      element: "el_a_1",
      role: "button",
      name: "Search",
      actions: ["click"],
    },
    {
      element: "el_a_2",
      role: "select",
      name: "Size",
      value: "S",
      options: ["S", "M", "M"],
      option_values: ["s", "m", "m-tall"],
      actions: ["select"],
    },
  ],
  next_cursor: null,
  ...over,
});
const step = (
  observation: Observation,
  history: StepRecord[] = [],
): StepInput => ({ goal: "g", observation, table: "", history, step: 0 });

describe("validateAnswer", () => {
  const ids = ["A", "B"];
  const ok = {
    choice: "A",
    confidence: 0.8,
    probabilities: { A: 0.8, B: 0.2 },
  };

  it("accepts a coherent answer", () => {
    expect(validateAnswer(ok, ids)).toBe(ok);
  });

  it.each([
    ["an unoffered choice", { ...ok, choice: "C" }],
    [
      "probabilities over other ids",
      { ...ok, probabilities: { A: 0.8, C: 0.2 } },
    ],
    ["probabilities missing an id", { ...ok, probabilities: { A: 1 } }],
    [
      "probabilities that do not sum to one",
      { ...ok, probabilities: { A: 0.8, B: 0.5 } },
    ],
    [
      "a choice that is not the most likely",
      { ...ok, probabilities: { A: 0.2, B: 0.8 } },
    ],
    ["a number out of range", { ...ok, confidence: 1.5 }],
    ["no answer at all", undefined],
  ])("refuses %s", (_, answer) => {
    expect(() => validateAnswer(answer as never, ids)).toThrow(
      /invalid answer/,
    );
  });
});

describe("JevDriver decisions", () => {
  it("offers scrolling only where there is more page, and scrolls up when asked", async () => {
    const top = fakeJev({ operation: "WAIT" });
    await new JevDriver({ fetch: top.fetch }).decide(step(page()));
    const offered = Object.keys(top.bodies[0]!.questions.operation.criteria);
    expect(offered).not.toContain("SCROLL_DOWN");
    expect(offered).not.toContain("SCROLL_UP");
    expect(offered).toContain("WAIT");

    const middle = fakeJev({ operation: "SCROLL_UP" });
    const d = await new JevDriver({ fetch: middle.fetch }).decide(
      step(page({ scroll: { y: 600, height: 3000, viewport: 600 } })),
    );
    expect(Object.keys(middle.bodies[0]!.questions.operation.criteria)).toEqual(
      expect.arrayContaining(["SCROLL_DOWN", "SCROLL_UP"]),
    );
    expect(d).toMatchObject({ op: "scroll", direction: "up" });
  });

  it("tells Jev which recent actions changed nothing", async () => {
    const jev = fakeJev({ operation: "WAIT" });
    const history: StepRecord[] = [
      { op: "click", element: "el_a_1", driver: "jev", page_changed: false },
      { op: "wait", driver: "jev" },
    ];
    await new JevDriver({ fetch: jev.fetch }).decide(step(page(), history));
    expect(jev.bodies[0]!.state.recent_actions).toEqual([
      { op: "click", element: "el_a_1", page_changed: false },
      { op: "wait" },
    ]);
  });

  it("selects by option value, which tells apart two options with one label", async () => {
    const jev = fakeJev({ operation: "SELECT", select_target: "el_a_2#2" });
    const d = await new JevDriver({ fetch: jev.fetch }).decide(step(page()));
    expect(d).toMatchObject({
      op: "select",
      element: "el_a_2",
      text: "M",
      value: "m-tall",
    });
  });

  it("retries a throttled request through TypeSafe's SDK", async () => {
    const jev = fakeJev({ operation: "WAIT" });
    let calls = 0;
    const fetch = (async (url: string, init: RequestInit) => {
      calls += 1;
      if (calls === 1) return new Response("slow down", { status: 429 });
      return jev.fetch(url, init);
    }) as unknown as typeof globalThis.fetch;
    const d = await new JevDriver({ fetch, retryDelayMs: 1 }).decide(
      step(page()),
    );
    expect(calls).toBe(2);
    expect(d.op).toBe("wait");
  });

  it("decides on the viewport, not the whole page", () => {
    expect(new JevDriver({}).observation).toBe("viewport");
  });
});
