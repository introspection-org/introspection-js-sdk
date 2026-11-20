/**
 * Restoring a Pi session from its telemetry repeats the provider request
 * prefix byte for byte, so a restore inside the prompt-cache lifetime reads
 * the whole previous prompt from cache.
 *
 * Every scenario runs on every route in `ROUTES` (provider, API and model),
 * each against its own Polly cassettes: a real pi-coding-agent session,
 * recorded through `instrumentSession`, restored into a fresh session from
 * the spans with `restoreSession`, then sent the next turn. The restored
 * request must match the one the live session sends for the same turn, and
 * repeat the previous request where the provider's cache keys. Replay serves
 * only recorded bodies, so a Pi release that changes the request shape fails
 * here; re-record with `POLLY_MODE=record` (see tests/README.md) and read the
 * diff. A missing cassette in replay, or a missing key in record, fails.
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
  getPollyMode,
  setupPolly,
  ensureEnvVarsForReplay,
  installTestOTelGlobals,
} from "../polly-setup";
import { piTracing, type PiTracing } from "./pi-fixtures";
import {
  ROUTES,
  builtinModel,
  resetSessionIds,
  datedSection,
  pinClock,
  referencePrompt,
  restoreInput,
  sharedPrefix,
  startSession,
  timeTool,
  weatherTool,
  type LiveSession,
  type ProviderCall,
  type Route,
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
  resetSessionIds();
  disposeOTel = installTestOTelGlobals();
  tracing = piTracing();
});

afterEach(async () => {
  for (const live of open.splice(0)) live.dispose();
  await tracing.provider.shutdown();
  disposeOTel();
});

async function start(
  route: Route,
  opts: SessionOptions,
  sessionId?: string,
): Promise<LiveSession> {
  const live = await startSession(tracing, route, opts, sessionId);
  open.push(live);
  return live;
}

/** A fresh session, under the same Pi session id, restored from `from`'s telemetry. */
async function restore(
  route: Route,
  from: LiveSession,
  opts: SessionOptions,
  restoreOpts: RestoreSessionOptions = {},
): Promise<LiveSession> {
  const input = await restoreInput(tracing, from.conversationId);
  const fresh = await start(route, opts, from.sessionId);
  await restoreSession(fresh.session, input.inputMessages, {
    toolLoadouts: input.toolLoadouts,
    ...restoreOpts,
  });
  return fresh;
}

/** Send `prompt` and return the provider calls it made; a failed call fails the test. */
async function turn(
  live: LiveSession,
  prompt: string,
): Promise<ProviderCall[]> {
  const before = live.calls.length;
  await live.session.prompt(prompt);
  const calls = live.calls.slice(before);
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) expect(call.error).toBeUndefined();
  return calls;
}

/**
 * Restore from `from` and send `prompt`. OpenAI's cache is best effort and
 * routes by key, so a first restore that reads nothing is tried once more.
 */
async function restoredTurn(
  route: Route,
  from: LiveSession,
  opts: SessionOptions,
  prompt: string,
  restoreOpts: RestoreSessionOptions = {},
): Promise<{ session: LiveSession; call: ProviderCall; attempts: number }> {
  let session = await restore(route, from, opts, restoreOpts);
  let [call] = await turn(session, prompt);
  let attempts = 1;
  if (route.provider === "openai" && call!.cacheRead === 0) {
    session = await restore(route, from, opts, restoreOpts);
    [call] = await turn(session, prompt);
    attempts = 2;
  }
  return { session, call: call!, attempts };
}

function report(
  route: Route,
  scenario: string,
  previous: ProviderCall,
  call: ProviderCall,
  attempts = 1,
) {
  console.info(
    `[pi-restore] ${route.model} ${scenario} cache_read ${call.cacheRead} of previous prompt ${previous.prompt}` +
      (attempts > 1 ? ` (attempt ${attempts})` : ""),
  );
}

/** The restored request repeats everything `previous` sent, and its cache read covers it. */
function expectFullPrefix(
  route: Route,
  previous: ProviderCall,
  restored: ProviderCall,
) {
  const shared = sharedPrefix(previous.body, restored.body);
  expect(shared).toEqual({
    tools: true,
    system: true,
    messages: shared.of,
    of: shared.of,
  });
  // The previous prompt ended with its own effort item, after its cache
  // breakpoint; OpenAI caches in 128-token steps.
  const slack = route.provider === "openai" ? 160 : previous.prompt * 0.05;
  expect(restored.cacheRead).toBeGreaterThanOrEqual(previous.prompt - slack);
}

/** Whether the route sends system messages mid-conversation rather than folding them into the prompt. */
async function midConversationSystem(route: Route): Promise<boolean> {
  const { getBuiltinModel } =
    await import("@earendil-works/pi-ai/providers/all");
  return (
    (
      builtinModel(getBuiltinModel, route)?.compat as
        { supportsMidConvoSystemMessages?: boolean } | undefined
    )?.supportsMidConvoSystemMessages === true
  );
}

describe("Pi internals the restore mirrors", () => {
  const route = ROUTES[0]!;

  it("resolves on this Pi release, and names the one missing when not", async () => {
    const { session } = await start(route, { tools: [await weatherTool()] });
    const internals = sessionInternals(session);
    expect(internals.baseOptions().selectedTools).toEqual(["get_weather"]);

    const renamed = Object.create(session) as Record<string, unknown>;
    renamed._preparePromptAndToolLoadout = undefined;
    expect(() => sessionInternals(renamed)).toThrow(
      /_preparePromptAndToolLoadout/,
    );
  });

  it("refuses a session that already holds a conversation", async () => {
    const { session } = await start(route, { tools: [await weatherTool()] });
    session.sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "hi" }],
      timestamp: 0,
    });
    session.refreshContext();
    await expect(restoreSession(session, [])).rejects.toThrow(/already holds/);
  });
});

for (const route of ROUTES) {
  describe(route.name, () => {
    const scenario = (name: string, run: (cell: string) => Promise<void>) => {
      describe(name, () => {
        const recording = `pi-restore-${route.name}-${name}`;
        let polly: Polly | null = null;
        let unavailable: string | null = null;
        beforeAll(() => {
          polly = setupPolly({ recordingName: recording, ordered: true });
          // Shaped like a real key: pi-ai reads any other OpenAI key as a
          // ChatGPT sign-in and sends a different request.
          if (getPollyMode() === "replay") {
            process.env[route.key] ??= "sk-polly-replay-dummy";
          }
          if (!ensureEnvVarsForReplay([route.key], recording)) {
            unavailable =
              getPollyMode() === "replay"
                ? `no cassette ${recording}: record it with POLLY_MODE=record and ${route.key}`
                : `${route.key} is not set, so nothing can be recorded`;
          }
        });
        afterAll(async () => {
          await polly?.stop();
          polly = null;
        });
        it("restores with the request prefix intact", async () => {
          if (unavailable) throw new Error(unavailable);
          await run(recording);
        });
      });
    };

    scenario("plain", async (cell) => {
      const opts = { cell, tools: [await weatherTool()] };
      const live = await start(route, opts);
      await turn(live, WEATHER);
      await turn(live, FOLLOW_UP);
      const previous = live.calls.at(-1)!;

      const { call, attempts } = await restoredTurn(route, live, opts, NEXT);
      const [liveNext] = await turn(live, NEXT);

      report(route, "plain", previous, call, attempts);
      expect(call.body).toEqual(liveNext!.body);
      expectFullPrefix(route, previous, call);
    });

    scenario("repeated", async (cell) => {
      const opts = { cell, tools: [await weatherTool()] };
      let current = await start(route, opts);
      await turn(current, WEATHER);
      for (const [i, prompt] of [
        FOLLOW_UP,
        NEXT,
        "Thanks. One word.",
      ].entries()) {
        const previous = current.calls.at(-1)!;
        const restored = await restoredTurn(route, current, opts, prompt);
        report(
          route,
          `repeated#${i + 1}`,
          previous,
          restored.call,
          restored.attempts,
        );
        expectFullPrefix(route, previous, restored.call);
        current = restored.session;
      }
    });

    scenario("tool-error", async (cell) => {
      const opts = {
        cell,
        tools: [await weatherTool(undefined, { fail: true })],
      };
      const live = await start(route, opts);
      await turn(live, WEATHER);
      const previous = live.calls.at(-1)!;
      if (route.provider !== "openai") {
        expect(JSON.stringify(previous.body)).toContain('"is_error":true');
      }

      const { call, attempts } = await restoredTurn(route, live, opts, NEXT);
      const [liveNext] = await turn(live, NEXT);

      report(route, "tool-error", previous, call, attempts);
      expect(call.body).toEqual(liveNext!.body);
      expectFullPrefix(route, previous, call);
    });

    scenario("thinking", async (cell) => {
      const opts: SessionOptions = {
        cell,
        tools: [await weatherTool()],
        thinkingLevel: "high",
      };
      const live = await start(route, opts);
      await turn(
        live,
        `${WEATHER} Then solve, reasoning it through first: a train leaves at 09:47 and travels 283 km at 74 km/h; when does it arrive, to the minute?`,
      );
      const previous = live.calls.at(-1)!;

      const { call, attempts } = await restoredTurn(route, live, opts, NEXT);
      const [liveNext] = await turn(live, NEXT);
      // The previous response's reasoning, signed, is in the restored history.
      // OpenRouter returns Claude's answer without thinking blocks.
      if (route.provider !== "openrouter") {
        expect(JSON.stringify(call.body)).toMatch(
          route.provider === "openai"
            ? /"type":"reasoning".*"encrypted_content":"[^"]+/
            : /"type":"thinking".*"signature":"[^"]+/,
        );
      }

      report(route, "thinking", previous, call, attempts);
      expect(call.body).toEqual(liveNext!.body);
      expectFullPrefix(route, previous, call);
    });

    scenario("multi-text", async (cell) => {
      const opts: SessionOptions = {
        cell,
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
      const live = await start(route, opts);
      await turn(live, `Read the brief. ${WEATHER}`);
      const previous = live.calls.at(-1)!;

      const { call, attempts } = await restoredTurn(route, live, opts, NEXT);
      const [liveNext] = await turn(live, NEXT);

      report(route, "multi-text", previous, call, attempts);
      expect(call.body).toEqual(liveNext!.body);
      expectFullPrefix(route, previous, call);
    });

    scenario("tool-added", async (cell) => {
      const tools = [await weatherTool(), await timeTool()];
      const live = await start(route, {
        cell,
        tools,
        activeTools: ["get_weather"],
      });
      await turn(live, WEATHER);
      live.session.setActiveToolsByName(["get_weather", "get_time"]);
      await turn(
        live,
        "What time is it in Tokyo? Use get_time, then answer briefly.",
      );
      await turn(live, FOLLOW_UP);
      const previous = live.calls.at(-1)!;
      if (route.provider === "anthropic") {
        const names = (previous.body.tools as { name: string }[]).map(
          (t) => t.name,
        );
        expect(names).toEqual(["get_weather", "__pi_deferred_placeholder__"]);
      }

      // The restoring session has both tools on, as the live one does now.
      const { call, attempts } = await restoredTurn(
        route,
        live,
        { cell, tools },
        NEXT,
      );
      const [liveNext] = await turn(live, NEXT);

      report(route, "tool-added", previous, call, attempts);
      expect(call.body).toEqual(liveNext!.body);
      expectFullPrefix(route, previous, call);
    });

    scenario("prompt-changed", async (cell) => {
      const tools = [await weatherTool()];
      const live = await start(route, { cell, tools });
      await turn(live, WEATHER);
      const previous = live.calls.at(-1)!;

      const redeployed = {
        tools,
        prompt: `${referencePrompt(route, cell)}\nAlways be polite.`,
      };
      // No second attempt: it would read what this one wrote.
      const restored = await restore(route, live, redeployed);
      const [call] = (await turn(restored, NEXT)) as [ProviderCall];

      report(route, "prompt-changed", previous, call);
      const shared = sharedPrefix(previous.body, call.body);
      expect(shared.tools).toBe(true);
      expect(shared.system).toBe(false);
      expect(shared.messages).toBe(shared.of);
      expect(JSON.stringify(call.body)).toContain("Always be polite.");
      // Accepted: the cache holds at most the tools, ahead of the prompt.
      expect(call.cacheRead).toBeLessThan(previous.prompt / 2);
    });

    scenario("later-day", async (cell) => {
      const created = new Date("2026-03-01T22:00:00Z");
      const clock: TestClock = { now: created };
      const opts = {
        cell,
        tools: [await weatherTool()],
        extensions: [datedSection(clock)],
      };
      const live = await start(route, opts);
      await turn(live, WEATHER);
      await turn(live, FOLLOW_UP);
      const previous = live.calls.at(-1)!;

      clock.now = new Date("2026-03-02T09:00:00Z");
      const { call, attempts } = await restoredTurn(route, live, opts, NEXT, {
        aroundHead: pinClock(clock, created),
      });
      const [liveNext] = await turn(live, NEXT);

      report(route, "later-day", previous, call, attempts);
      expect(call.body).toEqual(liveNext!.body);
      expect(JSON.stringify(call.body)).toContain("2026-03-02");
      if (await midConversationSystem(route)) {
        // The head keeps the cached date; the new one is a patch after the history.
        expectFullPrefix(route, previous, call);
      } else {
        // Accepted: the provider takes no mid-conversation system message, so
        // Pi folds the patch into the prompt and a live session misses alike.
        const shared = sharedPrefix(previous.body, call.body);
        expect(shared.system).toBe(false);
        expect(shared.messages).toBe(shared.of);
      }
    });

    scenario("compaction", async (cell) => {
      const opts = { cell, tools: [await weatherTool()] };
      const live = await start(route, opts);
      await turn(live, WEATHER);
      await turn(live, FOLLOW_UP);
      await live.session.compact();
      await turn(live, NEXT);
      const previous = live.calls.at(-1)!;

      const { call, attempts } = await restoredTurn(
        route,
        live,
        opts,
        "Thanks. One word.",
      );
      const [liveNext] = await turn(live, "Thanks. One word.");

      report(route, "compaction", previous, call, attempts);
      expect(call.body).toEqual(liveNext!.body);
      expectFullPrefix(route, previous, call);
    });

    scenario("combined", async (cell) => {
      const opts: SessionOptions = {
        cell,
        tools: [
          await weatherTool(undefined, { failFor: ["Paris"] }),
          await timeTool(),
        ],
        activeTools: ["get_weather"],
        thinkingLevel: "medium",
      };
      const live = await start(route, opts);
      await turn(live, WEATHER);
      // One response with two calls, one of which fails.
      const parallel = await turn(
        live,
        "Now call get_weather for Tokyo and for Paris in parallel, in one step, then compare them in one sentence.",
      );
      const results = parallel.at(-1)!.body;
      expect(JSON.stringify(results)).toContain(
        "Weather service unavailable for Paris",
      );
      live.session.setActiveToolsByName(["get_weather", "get_time"]);
      await turn(
        live,
        "What time is it in Tokyo? Use get_time, then answer briefly.",
      );
      await live.session.compact();
      await turn(live, FOLLOW_UP);
      const previous = live.calls.at(-1)!;

      // Restored from the live session, then from that restore.
      const restoredOpts = { ...opts, activeTools: undefined };
      const first = await restoredTurn(route, live, restoredOpts, NEXT);
      const [liveNext] = await turn(live, NEXT);
      report(route, "combined#1", previous, first.call, first.attempts);
      expect(first.call.body).toEqual(liveNext!.body);
      expectFullPrefix(route, previous, first.call);

      const again = "Thanks. One word.";
      const second = await restoredTurn(
        route,
        first.session,
        restoredOpts,
        again,
      );
      const [firstNext] = await turn(first.session, again);
      report(route, "combined#2", first.call, second.call, second.attempts);
      expect(second.call.body).toEqual(firstNext!.body);
      expectFullPrefix(route, first.call, second.call);
    });
  });
}
