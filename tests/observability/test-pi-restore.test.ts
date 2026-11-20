/**
 * Restoring a Pi session from its telemetry repeats the provider request
 * prefix byte for byte, so a restore inside the prompt-cache lifetime reads
 * the whole previous prompt from cache.
 *
 * Each scenario runs a real pi-coding-agent session against a Polly cassette
 * of Anthropic, records it through `instrumentSession`, restores a fresh
 * session from the spans with `restoreSession`, and sends the next turn. The
 * restored request must match the one the live session sends for the same
 * turn, and repeat the previous request where the provider's cache keys
 * (tools, system, messages). Replay serves only recorded bodies, so a Pi
 * release that changes the request shape fails here; re-record with
 * `POLLY_MODE=record` (see tests/README.md) and read the diff.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import type { Polly } from "@pollyjs/core";

import {
  restoreSession,
  type RestoreSessionOptions,
} from "@introspection-sdk/introspection-pi";
import { sessionInternals } from "../../packages/introspection-pi/src/session-internals";
import {
  setupPolly,
  ensureEnvVarsForReplay,
  installTestOTelGlobals,
} from "../polly-setup";
import { piTracing, type PiTracing } from "./pi-fixtures";
import {
  REFERENCE_PROMPT,
  datedSection,
  pinClock,
  restoreInput,
  sharedPrefix,
  startSession,
  timeTool,
  weatherTool,
  type LiveSession,
  type ProviderCall,
  type SessionOptions,
  type TestClock,
} from "./pi-restore-fixtures";

const WEATHER =
  "What is the weather in Tokyo? Use get_weather, then answer in one short sentence.";
const FOLLOW_UP = "Is that warm? One word.";
const NEXT = "Should I bring an umbrella? One word.";

let tracing: PiTracing;
let disposeOTel: () => void;
const open: LiveSession[] = [];

beforeEach(() => {
  disposeOTel = installTestOTelGlobals();
  tracing = piTracing();
});

afterEach(async () => {
  for (const live of open.splice(0)) live.dispose();
  await tracing.provider.shutdown();
  disposeOTel();
});

async function start(opts: SessionOptions): Promise<LiveSession> {
  const live = await startSession(tracing, opts);
  open.push(live);
  return live;
}

/** A fresh session restored from `from`'s telemetry. */
async function restore(
  from: LiveSession,
  opts: SessionOptions,
  restoreOpts: RestoreSessionOptions = {},
): Promise<LiveSession> {
  const input = await restoreInput(tracing, from.conversationId);
  const fresh = await start(opts);
  await restoreSession(fresh.session, input.inputMessages, {
    toolLoadouts: input.toolLoadouts,
    ...restoreOpts,
  });
  return fresh;
}

/** Send `prompt` and return the provider calls it made. */
async function turn(
  live: LiveSession,
  prompt: string,
): Promise<ProviderCall[]> {
  const before = live.calls.length;
  await live.session.prompt(prompt);
  return live.calls.slice(before);
}

/** The restored request repeats everything `previous` sent, and its cache read covers it. */
function expectFullPrefix(previous: ProviderCall, restored: ProviderCall) {
  const shared = sharedPrefix(previous.body, restored.body);
  expect(shared).toEqual({
    tools: true,
    system: true,
    messages: shared.of,
    of: shared.of,
  });
  // The previous prompt minus the effort marker it ended with, which is
  // after its cache breakpoint.
  expect(restored.cacheRead).toBeGreaterThan(previous.prompt * 0.95);
  console.info(
    `[pi-restore] cache_read ${restored.cacheRead} of previous prompt ${previous.prompt}`,
  );
}

function scenario(
  name: string,
  body: (ctx: { polly: () => Polly | null }) => void,
) {
  describe(name, () => {
    let polly: Polly | null = null;
    const recording = `pi-restore-${name}`;
    beforeAll(async () => {
      polly = setupPolly({ recordingName: recording });
      if (!ensureEnvVarsForReplay(["ANTHROPIC_API_KEY"], recording)) {
        await polly.stop();
        polly = null;
      }
    });
    afterAll(async () => {
      await polly?.stop();
      polly = null;
    });
    body({ polly: () => polly });
  });
}

describe("Pi internals the restore mirrors", () => {
  it("resolves on this Pi release, and names the one missing when not", async () => {
    const { session } = await start({ tools: [await weatherTool()] });
    const internals = sessionInternals(session);
    expect(internals.baseOptions().selectedTools).toEqual(["get_weather"]);

    const renamed = Object.create(session) as Record<string, unknown>;
    renamed._preparePromptAndToolLoadout = undefined;
    expect(() => sessionInternals(renamed)).toThrow(
      /_preparePromptAndToolLoadout/,
    );
  });

  it("refuses a session that already holds a conversation", async () => {
    const { session } = await start({ tools: [await weatherTool()] });
    session.sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "hi" }],
      timestamp: 0,
    });
    session.refreshContext();
    await expect(restoreSession(session, [])).rejects.toThrow(/already holds/);
  });
});

scenario("plain", ({ polly }) => {
  it("restores a multi-turn conversation with a tool call", async () => {
    if (!polly()) return;
    const opts = { tools: [await weatherTool()] };
    const live = await start(opts);
    await turn(live, WEATHER);
    await turn(live, FOLLOW_UP);
    const previous = live.calls.at(-1)!;

    const restored = await restore(live, opts);
    const [next] = await turn(restored, NEXT);
    const [liveNext] = await turn(live, NEXT);

    expect(next!.body).toEqual(liveNext!.body);
    expectFullPrefix(previous, next!);
  });
});

scenario("repeated", ({ polly }) => {
  it("keeps the prefix across three restores of one conversation", async () => {
    if (!polly()) return;
    const opts = { tools: [await weatherTool()] };
    let current = await start(opts);
    await turn(current, WEATHER);
    for (const prompt of [FOLLOW_UP, NEXT, "Thanks. One word."]) {
      const previous = current.calls.at(-1)!;
      current = await restore(current, opts);
      const [next] = await turn(current, prompt);
      expectFullPrefix(previous, next!);
    }
  });
});

scenario("tool-error", ({ polly }) => {
  it("sends a failed tool result back as an error", async () => {
    if (!polly()) return;
    const opts = { tools: [await weatherTool(undefined, { fail: true })] };
    const live = await start(opts);
    await turn(live, WEATHER);
    const previous = live.calls.at(-1)!;
    expect(JSON.stringify(previous.body)).toContain('"is_error":true');

    const restored = await restore(live, opts);
    const [next] = await turn(restored, NEXT);
    const [liveNext] = await turn(live, NEXT);

    expect(next!.body).toEqual(liveNext!.body);
    expectFullPrefix(previous, next!);
  });
});

scenario("thinking", ({ polly }) => {
  it("keeps signed thinking and its effort", async () => {
    if (!polly()) return;
    const opts: SessionOptions = {
      tools: [await weatherTool()],
      thinkingLevel: "medium",
    };
    const live = await start(opts);
    await turn(live, `${WEATHER} Think first: is 25°C warmer than 70°F?`);
    const previous = live.calls.at(-1)!;
    expect(JSON.stringify(previous.body)).toMatch(
      /"type":"thinking"[^}]*"signature":"[^"]+/,
    );

    const restored = await restore(live, opts);
    const [next] = await turn(restored, NEXT);
    const [liveNext] = await turn(live, NEXT);

    expect(next!.body).toEqual(liveNext!.body);
    expectFullPrefix(previous, next!);
  });
});

scenario("multi-text", ({ polly }) => {
  it("keeps a user message of several text blocks as blocks", async () => {
    if (!polly()) return;
    const opts: SessionOptions = {
      tools: [await weatherTool()],
      // A message an extension adds with the prompt: one user turn, two blocks.
      extensions: [
        (pi) => {
          pi.on("before_agent_start", (event) =>
            event.messageType === "user" && event.prompt.includes("brief")
              ? {
                  message: {
                    customType: "brief",
                    content: [
                      {
                        type: "text",
                        text: "Brief: the traveller is in Tokyo.",
                      },
                      { type: "text", text: "Keep answers short." },
                    ],
                    display: false,
                  },
                }
              : undefined,
          );
        },
      ],
    };
    const live = await start(opts);
    await turn(live, `Read the brief. ${WEATHER}`);
    const previous = live.calls.at(-1)!;

    const restored = await restore(live, opts);
    const [next] = await turn(restored, NEXT);
    const [liveNext] = await turn(live, NEXT);

    expect(next!.body).toEqual(liveNext!.body);
    expectFullPrefix(previous, next!);
  });
});

scenario("tool-added", ({ polly }) => {
  it("declares the first run's tools at the head and a later tool where it was added", async () => {
    if (!polly()) return;
    const tools = [await weatherTool(), await timeTool()];
    const live = await start({ tools, activeTools: ["get_weather"] });
    await turn(live, WEATHER);
    live.session.setActiveToolsByName(["get_weather", "get_time"]);
    await turn(
      live,
      "What time is it in Tokyo? Use get_time, then answer briefly.",
    );
    await turn(live, FOLLOW_UP);
    const previous = live.calls.at(-1)!;
    const names = (previous.body.tools as { name: string }[]).map(
      (t) => t.name,
    );
    expect(names).toEqual(["get_weather", "__pi_deferred_placeholder__"]);

    // The restoring session has both tools on, as the live one does now.
    const restored = await restore(live, { tools });
    const [next] = await turn(restored, NEXT);
    const [liveNext] = await turn(live, NEXT);

    expect(next!.body).toEqual(liveNext!.body);
    expectFullPrefix(previous, next!);
  });
});

scenario("prompt-changed", ({ polly }) => {
  it("rebuilds the head from the current prompt, so the cache holds only the tools", async () => {
    if (!polly()) return;
    const tools = [await weatherTool()];
    const live = await start({ tools });
    await turn(live, WEATHER);
    const previous = live.calls.at(-1)!;

    const redeployed = {
      tools,
      prompt: `${REFERENCE_PROMPT}\nAlways be polite.`,
    };
    const restored = await restore(live, redeployed);
    const [next] = await turn(restored, NEXT);

    const shared = sharedPrefix(previous.body, next!.body);
    expect(shared.tools).toBe(true);
    expect(shared.system).toBe(false);
    expect(shared.messages).toBe(shared.of);
    expect(JSON.stringify(next!.body.system)).toContain("Always be polite.");
    expect(next!.cacheRead).toBeLessThan(previous.prompt / 2);
    console.info(
      `[pi-restore] prompt changed: cache_read ${next!.cacheRead} of previous prompt ${previous.prompt}`,
    );
  });
});

scenario("later-day", ({ polly }) => {
  it("keeps the original date at the head and patches the new one", async () => {
    if (!polly()) return;
    const created = new Date("2026-03-01T22:00:00Z");
    const clock: TestClock = { now: created };
    const opts = {
      tools: [await weatherTool()],
      extensions: [datedSection(clock)],
    };
    const live = await start(opts);
    await turn(live, WEATHER);
    await turn(live, FOLLOW_UP);
    const previous = live.calls.at(-1)!;

    clock.now = new Date("2026-03-02T09:00:00Z");
    const restored = await restore(live, opts, {
      aroundHead: pinClock(clock, created),
    });
    const [next] = await turn(restored, NEXT);
    const [liveNext] = await turn(live, NEXT);

    expect(next!.body).toEqual(liveNext!.body);
    expectFullPrefix(previous, next!);
    expect(JSON.stringify(next!.body.system)).toContain("2026-03-01");
    const patch = next!.body.messages.filter((m) => m.role === "system");
    expect(JSON.stringify(patch)).toContain("2026-03-02");
  });
});

scenario("compaction", ({ polly }) => {
  it("restores a history that opens with a compaction", async () => {
    if (!polly()) return;
    const opts = { tools: [await weatherTool()] };
    const live = await start(opts);
    await turn(live, WEATHER);
    await turn(live, FOLLOW_UP);
    await live.session.compact();
    await turn(live, NEXT);
    const previous = live.calls.at(-1)!;

    const restored = await restore(live, opts);
    const [next] = await turn(restored, "Thanks. One word.");
    const [liveNext] = await turn(live, "Thanks. One word.");

    expect(next!.body).toEqual(liveNext!.body);
    expectFullPrefix(previous, next!);
  });
});
