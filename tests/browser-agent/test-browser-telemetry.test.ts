// Every model call a browser driver makes is a GenAI client span with the
// usage the provider reported — the same shape introspection-pi gives a Pi
// chat call, so the platform's usage aggregation and billing read it the same
// way. Spans go through the real IntrospectionSpanProcessor (piTracing).
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Polly } from "@pollyjs/core";
import {
  ClaudeDriver,
  JEV_OPERATION,
  JevDriver,
  OpenAICompatibleDriver,
  USAGE_MISSING,
  type AnthropicClientLike,
  type Observation,
  type StepInput,
} from "@introspection-sdk/browser-agent";
import {
  ensureEnvVarsForReplay,
  pollyEndpoints,
  setupPolly,
} from "../polly-setup";
import { piTracing } from "../observability/pi-fixtures";
import { fakeJev } from "./jev-fake";

const tracing = piTracing();
afterEach(() => tracing.exporter.reset());
afterAll(async () => {
  await tracing.provider.shutdown();
});

const spans = async () => {
  await tracing.provider.forceFlush();
  return tracing.spans();
};

const OBSERVATION: Observation = {
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
  ],
  next_cursor: null,
};
const input: StepInput = {
  goal: "search",
  observation: OBSERVATION,
  table: "",
  history: [],
  step: 0,
};

describe("JevDriver spans (recorded)", () => {
  const TRAJECTORY = JSON.parse(
    readFileSync(
      new URL("./fixtures/wikipedia-chromium.json", import.meta.url),
      "utf8",
    ),
  ) as {
    goal: string;
    slots: Record<string, string>;
    steps: { observation: Observation }[];
  };
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
      void polly.stop();
      polly = null;
    }
  });
  afterAll(async () => {
    await polly?.stop();
  });

  it("records the request, the model that answered and its token usage", async () => {
    if (!polly) return;
    await new JevDriver({
      apiKey: process.env.TYPESAFE_API_KEY,
      baseUrl: pollyEndpoints.typesafe.base,
      slots: TRAJECTORY.slots,
      telemetry: { attributes: () => ({ "introspection.byok": false }) },
    }).decide({
      goal: TRAJECTORY.goal,
      observation: TRAJECTORY.steps[0]!.observation,
      table: "",
      history: [],
      step: 0,
    });

    const [span] = await spans();
    expect(span!.name).toBe(`${JEV_OPERATION} jev-latest`);
    expect(span!.attributes).toMatchObject({
      "gen_ai.operation.name": "generate_content",
      "gen_ai.provider.name": "typesafe",
      "gen_ai.request.model": "jev-latest",
      "server.address": "api.typesafe.ai",
      "introspection.byok": false,
    });
    expect(span!.attributes["gen_ai.response.model"]).toMatch(/^jev-/);
    expect(span!.attributes["gen_ai.usage.input_tokens"]).toBeGreaterThan(0);
    expect(span!.attributes["gen_ai.usage.output_tokens"]).toBeGreaterThan(0);
    expect(span!.attributes[USAGE_MISSING]).toBeUndefined();
  });
});

describe("driver spans", () => {
  it("marks a failed Jev request with its HTTP status", async () => {
    const fetch = (async () =>
      new Response("slow down", {
        status: 429,
      })) as unknown as typeof globalThis.fetch;
    await expect(
      new JevDriver({ fetch, retryDelayMs: 1 }).decide(input),
    ).rejects.toThrow(/HTTP 429/);
    const [span] = await spans();
    expect(span!.attributes["error.type"]).toBe("429");
    expect(span!.status.code).toBe(2);
  });

  it("counts Claude's cache tokens inside the input total", async () => {
    const message = {
      id: "msg_1",
      model: "claude-opus-5",
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          name: "browser_action",
          input: { op: "click", element: "el_a_1", reason: "search" },
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 10,
      },
    };
    const client: AnthropicClientLike = {
      messages: { create: async () => message },
      beta: { messages: { create: async () => message } },
    };
    await new ClaudeDriver({ client }).decide(input);

    const [span] = await spans();
    expect(span!.name).toBe("chat claude-opus-5");
    expect(span!.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.response.model": "claude-opus-5",
      "gen_ai.response.id": "msg_1",
      "gen_ai.usage.input_tokens": 160,
      "gen_ai.usage.output_tokens": 20,
      "gen_ai.usage.cache_read.input_tokens": 50,
      "gen_ai.usage.cache_creation.input_tokens": 10,
    });
  });

  it("does not count OpenAI's cached tokens twice", async () => {
    const fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          model: "gpt-5-mini-2026-01-01",
          choices: [
            {
              message: {
                content: '{"op":"click","element":"el_a_1","reason":"x"}',
              },
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 7,
            prompt_tokens_details: { cached_tokens: 40 },
          },
        }),
      )) as unknown as typeof globalThis.fetch;
    await new OpenAICompatibleDriver({
      model: "gpt-5-mini",
      fetch,
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
    }).decide(input);

    const [span] = await spans();
    expect(span!.attributes).toMatchObject({
      "gen_ai.provider.name": "openrouter",
      "gen_ai.request.model": "gpt-5-mini",
      "gen_ai.response.model": "gpt-5-mini-2026-01-01",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.cache_read.input_tokens": 40,
      "server.address": "openrouter.ai",
    });
  });

  it("flags a call whose provider reported no usage", async () => {
    const withUsage = fakeJev({ operation: "WAIT" });
    await new JevDriver({ fetch: withUsage.fetch }).decide(input);
    const partial = fakeJev({ operation: "WAIT" }, { input_tokens: 10 });
    await new JevDriver({ fetch: partial.fetch }).decide(input);
    const none = fakeJev({ operation: "WAIT" }, null);
    await new JevDriver({ fetch: none.fetch }).decide(input);

    const [counted, halfCounted, uncounted] = await spans();
    expect(counted!.attributes[USAGE_MISSING]).toBeUndefined();
    expect(halfCounted!.attributes[USAGE_MISSING]).toBe(true);
    expect(uncounted!.attributes[USAGE_MISSING]).toBe(true);
    expect(uncounted!.attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
  });

  it("emits nothing when telemetry is off", async () => {
    const { fetch } = fakeJev({ operation: "WAIT" });
    await new JevDriver({ fetch, telemetry: false }).decide(input);
    expect(await spans()).toHaveLength(0);
  });
});
