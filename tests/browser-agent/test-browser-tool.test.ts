// Drivers here are scripted policies, not mocks of any HTTP API: the model
// drivers have their own recorded tests. The browser is real Chromium.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BrowserSession,
  DEFAULT_GATE_POLICY,
  GatedDriver,
  createBrowserTool,
  historyText,
  renderTable,
  reviewReason,
  type Decision,
  type Driver,
  type Observation,
  type StepInput,
} from "@introspection-sdk/browser-agent";
import {
  findChrome,
  launchChrome,
  serveFixture,
  type FixtureServer,
  type LaunchedChrome,
} from "./chrome";

const chrome = findChrome();

const OBSERVATION: Observation = {
  version: "browser.v1",
  tab_id: "t1",
  url: "https://shop.test/",
  title: "Shop",
  text: "Welcome",
  scroll: { y: 0, height: 2000, viewport: 600 },
  elements: [
    {
      element: "el_a_1",
      role: "searchbox",
      name: "Search",
      value: "",
      actions: ["type", "click"],
    },
    {
      element: "el_a_2",
      role: "button",
      name: "Submit order",
      actions: ["click"],
    },
    {
      element: "el_a_3",
      role: "select",
      name: "Size",
      value: "S",
      options: ["S", "M"],
      actions: ["select"],
    },
    {
      element: "el_a_4",
      role: "checkbox",
      name: "Gift",
      checked: true,
      expanded: false,
      disabled: true,
      offscreen: true,
      actions: ["click"],
    },
  ],
  next_cursor: 4,
};

const signal = (
  op: number,
  target?: { confidence: number; margin: number },
) => ({
  op: { choice: "CLICK", confidence: op, margin: 0.5, top: [] },
  ...(target
    ? {
        target: {
          choice: "el_a_1",
          confidence: target.confidence,
          margin: target.margin,
          top: [
            { choice: "el_a_1", p: 0.5 },
            { choice: "el_a_2", p: 0.4 },
          ],
        },
      }
    : {}),
});

describe("renderTable and history", () => {
  it("renders every element attribute a driver needs", () => {
    const table = renderTable(OBSERVATION);
    expect(table).toContain(
      `[el_a_1] searchbox "Search" = "" actions: type,click`,
    );
    expect(table).toContain("options: S | M");
    expect(table).toContain("(checked) (collapsed)");
    expect(table).toContain("(disabled) (offscreen)");
    expect(table).toContain("(more elements: cursor 4)");
    expect(table).toContain("untrusted data");
  });

  it("summarises recent steps", () => {
    expect(historyText([])).toBe("(none)");
    expect(
      historyText([
        { op: "type", element: "el_a_1", text: "hat", driver: "d" },
        {
          op: "navigate",
          url: "https://x.test",
          driver: "d",
          error: "blocked",
        },
      ]),
    ).toBe(
      `1. type [el_a_1] "hat"\n2. navigate https://x.test -> ERROR blocked`,
    );
  });
});

describe("reviewReason (confidence gate)", () => {
  const d = (over: Partial<Decision>): Decision => ({
    op: "click",
    element: "el_a_1",
    ...over,
  });

  it("accepts confident decisions and decisions without a signal", () => {
    expect(
      reviewReason(
        d({ signal: signal(0.9, { confidence: 0.9, margin: 0.8 }) }),
        OBSERVATION,
      ),
    ).toBeNull();
    expect(reviewReason(d({}), OBSERVATION)).toBeNull();
  });

  it("escalates blocked, early done, low operation or target confidence, and close targets", () => {
    expect(
      reviewReason(d({ op: "blocked", reason: "stuck" }), OBSERVATION),
    ).toMatch(/blocked: stuck/);
    expect(
      reviewReason(d({ op: "done", signal: signal(0.53) }), OBSERVATION),
    ).toMatch(/done at 0.53/);
    expect(reviewReason(d({ signal: signal(0.4) }), OBSERVATION)).toMatch(
      /operation confidence/,
    );
    expect(
      reviewReason(
        d({ signal: signal(0.9, { confidence: 0.5, margin: 0.8 }) }),
        OBSERVATION,
      ),
    ).toMatch(/target confidence/);
    expect(
      reviewReason(
        d({ signal: signal(0.9, { confidence: 0.9, margin: 0.1 }) }),
        OBSERVATION,
      ),
    ).toMatch(/too close/);
  });

  it("holds state-changing clicks to a higher bar", () => {
    const risky = d({
      element: "el_a_2",
      signal: signal(0.7, { confidence: 0.9, margin: 0.8 }),
    });
    expect(reviewReason(risky, OBSERVATION)).toMatch(
      /state-changing "Submit order"/,
    );
    expect(
      reviewReason(risky, OBSERVATION, {
        ...DEFAULT_GATE_POLICY,
        minRiskyConfidence: 0.6,
      }),
    ).toBeNull();
  });
});

describe("GatedDriver", () => {
  const input: StepInput = {
    goal: "g",
    observation: OBSERVATION,
    table: "",
    history: [],
    step: 0,
  };
  const fixed = (name: string, decision: Decision | Error): Driver => ({
    name,
    async decide() {
      if (decision instanceof Error) throw decision;
      return decision;
    },
  });

  it("keeps the fast decision when the gate passes", async () => {
    const gated = new GatedDriver(
      fixed("fast", { op: "click", element: "el_a_1", signal: signal(0.9) }),
      fixed("slow", { op: "done" }),
    );
    expect(gated.name).toBe("fast?slow");
    expect(await gated.decide(input)).toMatchObject({ op: "click" });
  });

  it("asks the fallback, with the fast driver's candidates, when it fails", async () => {
    let seenGoal = "";
    const slow: Driver = {
      name: "slow",
      vision: true,
      async decide(i) {
        seenGoal = i.goal;
        return { op: "scroll", direction: "down" };
      },
    };
    const gated = new GatedDriver(
      fixed("fast", { op: "click", element: "el_a_1", signal: signal(0.2) }),
      slow,
    );
    expect(gated.vision).toBe(true);
    expect(await gated.decide(input)).toMatchObject({
      op: "scroll",
      escalated: "operation confidence 0.2",
    });
    expect(seenGoal).toContain("A fast model proposed click [el_a_1]");
  });

  it("treats a failing fast driver as blocked", async () => {
    const gated = new GatedDriver(
      fixed("fast", new Error("HTTP 500")),
      fixed("slow", { op: "done", text: "ok" }),
    );
    expect(await gated.decide(input)).toMatchObject({
      op: "done",
      escalated: "fast driver blocked: HTTP 500",
    });
  });
});

describe.skipIf(!chrome)("run and the browser tool against Chromium", () => {
  let browser: LaunchedChrome;
  let fixture: FixtureServer;
  let session: BrowserSession;

  /** A scripted policy over the element table, the way a real driver reads it. */
  const searchPolicy = (name = "scripted"): Driver => ({
    name,
    async decide({ observation: o }) {
      const by = (n: string) => o.elements.find((e) => e.name.includes(n))!;
      if (by("Destination").value !== "Lisbon")
        return {
          op: "type",
          element: by("Destination").element,
          text: "Lisbon",
        };
      if (by("Category").value !== "Design")
        return {
          op: "select",
          element: by("Category").element,
          text: "Design",
        };
      if (!o.text.includes("searched"))
        return { op: "click", element: by("Search").element };
      return { op: "done", text: o.text.match(/searched .*/)![0] };
    },
  });
  const always = (name: string, decision: Decision): Driver => ({
    name,
    decide: async () => decision,
  });

  beforeAll(async () => {
    browser = await launchChrome(chrome!);
    fixture = await serveFixture();
    session = await BrowserSession.connect(browser.endpoint, {
      allowedDomains: ["127.0.0.1"],
    });
  });
  afterAll(async () => {
    session?.close();
    await browser?.close();
    await fixture?.close();
  });
  beforeEach(async () => {
    await session.navigate({ url: fixture.url });
  });

  it("completes a goal and verifies success from the page", async () => {
    const seen: string[] = [];
    const result = await session.run({
      goal: "Design stays in Lisbon",
      drivers: [searchPolicy()],
      success: (o) => o.text.includes("searched Lisbon / Design"),
      onStep: (s) => seen.push(s.op),
    });
    expect(result).toMatchObject({
      status: "done",
      result: "searched Lisbon / Design / any",
      escalations: 0,
    });
    expect(seen).toEqual(["type", "select", "click", "done"]);
  });

  it("does not accept done until the success check passes", async () => {
    const result = await session.run({
      goal: "g",
      drivers: [always("liar", { op: "done", text: "trust me" })],
      success: () => false,
      maxSteps: 3,
    });
    // Three unverified claims in a row, with no rung left to escalate to.
    expect(result).toMatchObject({
      status: "failed",
      reason: "success check failed",
    });
    expect(result.steps).toHaveLength(3);
  });

  it("escalates to the next rung on blocked, and reports blocked at the top", async () => {
    const escalated = await session.run({
      goal: "g",
      drivers: [
        always("cheap", { op: "blocked", reason: "custom widget" }),
        searchPolicy("strong"),
      ],
    });
    expect(escalated).toMatchObject({ status: "done", escalations: 1 });
    expect(escalated.steps[0]).toMatchObject({
      driver: "cheap",
      op: "blocked",
    });

    const stuck = await session.run({
      goal: "g",
      drivers: [always("only", { op: "blocked", reason: "no way" })],
    });
    expect(stuck).toMatchObject({ status: "blocked", reason: "no way" });
  });

  it("escalates after repeated invalid actions and fails when nothing is left", async () => {
    const bad = always("bad", { op: "click", element: "el_forged_9" });
    const escalated = await session.run({
      goal: "g",
      drivers: [bad, searchPolicy()],
    });
    expect(escalated.status).toBe("done");
    expect(escalated.steps.filter((s) => s.driver === "bad")).toHaveLength(2);

    const failed = await session.run({ goal: "g", drivers: [bad] });
    expect(failed.status).toBe("failed");
    expect(failed.reason).toMatch(/^stale:/);
  });

  it("performs scroll, navigate and wait, and rejects malformed decisions", async () => {
    const script: Decision[] = [
      { op: "scroll" },
      { op: "navigate", url: `${fixture.url}/second` },
      { op: "wait" },
      { op: "click" },
      { op: "navigate" },
      { op: "wait" },
      { op: "teleport" as never },
      { op: "done", text: "fin" },
    ];
    let i = 0;
    const result = await session.run({
      goal: "g",
      drivers: [{ name: "script", decide: async () => script[i++]! }],
      stepsPerRung: 99,
      maxSteps: 10,
    });
    expect(result.status).toBe("done");
    expect(result.url).toContain("/second");
    expect(result.steps.map((s) => s.error ?? "ok")).toEqual([
      "ok",
      "ok",
      "ok",
      "invalid_argument: click needs an element",
      "invalid_argument: navigate needs a url",
      "ok",
      "invalid_argument: unknown op teleport",
      "ok",
    ]);
  });

  it("records driver exceptions as blocked and honours abort", async () => {
    const thrown = await session.run({
      goal: "g",
      drivers: [
        {
          name: "boom",
          decide: async () => {
            throw new Error("upstream 500");
          },
        },
      ],
    });
    expect(thrown).toMatchObject({
      status: "blocked",
      reason: "driver error: upstream 500",
    });

    const ctl = new AbortController();
    ctl.abort();
    expect(
      (
        await session.run({
          goal: "g",
          drivers: [searchPolicy()],
          signal: ctl.signal,
        })
      ).status,
    ).toBe("aborted");
  });

  it("dispatches every command through the browser tool", async () => {
    const tool = createBrowserTool({
      session,
      drivers: [searchPolicy()],
      resolveFile: async () => "/etc/hostname",
      validateTarget: (url) => {
        if (url.includes("forbidden")) throw new Error("not this one");
      },
    });
    expect(tool.commands).toContain("run");
    expect(
      (tool.inputSchema.properties as Record<string, { enum?: string[] }>)
        .command!.enum,
    ).toContain("run");

    const o = (await tool.call({ command: "observe" })) as Observation;
    const dest = o.elements.find((e) =>
      e.name.includes("Destination"),
    )!.element;
    expect(
      await tool.call({
        command: "act",
        element: dest,
        action: "type",
        text: "Rome",
      }),
    ).toMatchObject({ value: "Rome" });
    const upload = o.elements.find((e) =>
      e.name.includes("Attachment"),
    )!.element;
    expect(
      await tool.call({
        command: "act",
        element: upload,
        action: "upload",
        file: "file_1",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await tool.call({ command: "scroll", direction: "down" }),
    ).toMatchObject({ moved: true });
    expect(await tool.call({ command: "tabs" })).toHaveLength(1);
    expect(await tool.call({ command: "screenshot" })).toMatchObject({
      mime_type: "image/jpeg",
    });
    await expect(
      tool.call({ command: "navigate", url: `${fixture.url}/forbidden` }),
    ).rejects.toThrow("not this one");
    expect(
      await tool.call({ command: "navigate", url: fixture.url }),
    ).toMatchObject({ active: true });
    expect(
      await tool.call({ command: "run", goal: "Lisbon design" }),
    ).toMatchObject({ status: "done" });
    await expect(
      tool.call({ command: "act", element: dest } as never),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(
      tool.call({ command: "act", element: upload, action: "upload" }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("builds the run driver stack per call, passing inputs through", async () => {
    let seen: Record<string, string> | undefined;
    const tool = createBrowserTool({
      session,
      drivers: (input) => {
        seen = input.inputs;
        return [searchPolicy()];
      },
    });
    expect(tool.commands).toContain("run");
    expect(
      await tool.call({
        command: "run",
        goal: "g",
        inputs: { Destination: "Lisbon" },
      }),
    ).toMatchObject({ status: "done" });
    expect(seen).toEqual({ Destination: "Lisbon" });
    expect(createBrowserTool({ session, drivers: [] }).commands).not.toContain(
      "run",
    );
  });

  it("narrows the schema to allowed and supported commands", async () => {
    const readOnly = createBrowserTool({
      session,
      commands: ["observe", "tabs"],
    });
    expect(
      (readOnly.inputSchema.properties as Record<string, { enum?: string[] }>)
        .command!.enum,
    ).toEqual(["observe", "tabs"]);
    expect(readOnly.inputSchema.properties).not.toHaveProperty("element");
    await expect(
      readOnly.call({ command: "act", element: "x", action: "click" }),
    ).rejects.toMatchObject({ code: "not_allowed" });

    const noDrivers = createBrowserTool({ session });
    expect(noDrivers.commands).not.toContain("run");
    expect(() => createBrowserTool({ session, commands: ["run"] })).toThrow(
      /not supported/,
    );
    const o = (await noDrivers.call({ command: "observe" })) as Observation;
    const upload = o.elements.find((e) =>
      e.name.includes("Attachment"),
    )!.element;
    await expect(
      noDrivers.call({
        command: "act",
        element: upload,
        action: "upload",
        file: "f",
      }),
    ).rejects.toMatchObject({ code: "unsupported" });
  });
});
