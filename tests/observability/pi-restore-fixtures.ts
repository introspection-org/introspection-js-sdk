/**
 * Fixtures for the Pi session restore tests: a real pi-coding-agent
 * `AgentSession` on one provider route, the request bodies it sends, and the
 * restore inputs read back from the telemetry the SDK's recorder emitted.
 */

import { mkdirSync } from "node:fs";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type {
  AgentSession,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

import {
  instrumentSession,
  type InputMessage,
  type OutputMessage,
  type RecordedToolLoadout,
} from "@introspection-sdk/introspection-pi";
import type { PiTracing } from "./pi-fixtures";

/** A provider and model a restore is checked on, with its own cassettes. */
export interface Route {
  name: string;
  provider: "anthropic" | "openai" | "openrouter";
  model: string;
  /** The env var Pi reads the provider's key from. */
  key: string;
  thinkingLevel: ThinkingLevel;
  /** Lines of reference text: enough to clear the model's minimum cacheable prompt. */
  referenceLines: number;
}

export const ROUTES: readonly Route[] = [
  {
    name: "anthropic-sonnet-5-5",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    key: "ANTHROPIC_API_KEY",
    thinkingLevel: "low",
    referenceLines: 120,
  },
  {
    name: "anthropic-opus-5-5",
    provider: "anthropic",
    model: "claude-opus-5-5",
    key: "ANTHROPIC_API_KEY",
    thinkingLevel: "medium",
    referenceLines: 120,
  },
  {
    name: "anthropic-haiku-5-5",
    provider: "anthropic",
    model: "claude-haiku-5-5",
    key: "ANTHROPIC_API_KEY",
    thinkingLevel: "low",
    referenceLines: 260,
  },
  {
    name: "openai-gpt-6-luna",
    provider: "openai",
    model: "gpt-6-luna",
    key: "OPENAI_API_KEY",
    thinkingLevel: "low",
    referenceLines: 120,
  },
  {
    name: "openrouter-claude-sonnet-5-5",
    provider: "openrouter",
    model: "anthropic/claude-sonnet-5.5",
    key: "OPENROUTER_API_KEY",
    thinkingLevel: "low",
    referenceLines: 120,
  },
];

// The prompt renders the working directory, and the cassettes match on body.
const CWD = "/tmp/introspection-pi-restore";

/**
 * Reference text that lifts the cached prefix over the provider's minimum
 * cacheable length; a shorter prompt is never cached at all.
 */
export function referencePrompt(route: Route, cell = ""): string {
  return [
    // Names the cell, so no cell reads a prefix another one cached.
    `Reference for ${cell || route.name}: the weather desk's station catalog. Use it only when asked.`,
    ...Array.from(
      { length: route.referenceLines },
      (_, i) =>
        `- Station ${i + 1}: code WX${String(i + 1).padStart(3, "0")}, elevation ${(i * 37) % 900} m, reports hourly.`,
    ),
  ].join("\n");
}

/** The request body the provider was sent, and the usage it answered with. */
export interface ProviderCall {
  body: ProviderRequest;
  cacheRead: number;
  /** Input tokens of the whole prompt: uncached, read and written. */
  prompt: number;
  /** The provider's error, when the call failed. */
  error?: string;
}

export type ProviderRequest = Record<string, unknown>;

/** A clock an extension reads, as Recipes reads its own. */
export interface TestClock {
  now: Date;
  pinned?: Date;
}

/** Renders the day as a prompt section on every run start, from `clock`. */
export function datedSection(clock: TestClock): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", (event) => {
      const at = clock.pinned ?? clock.now;
      event.systemPromptOptions.sections.current_date = at
        .toISOString()
        .slice(0, 10);
    });
  };
}

/** Pin `clock` to `at` while `build` runs: what a host passes as `aroundHead`. */
export function pinClock(clock: TestClock, at: Date) {
  return async <T>(build: () => Promise<T>): Promise<T> => {
    clock.pinned = at;
    try {
      return await build();
    } finally {
      clock.pinned = undefined;
    }
  };
}

export interface WeatherLog {
  calls: string[];
}

/** A deterministic tool, so a recorded follow-up request embeds a fixed result. */
export async function weatherTool(
  log: WeatherLog = { calls: [] },
  { fail = false, failFor = [] }: { fail?: boolean; failFor?: string[] } = {},
): Promise<ToolDefinition> {
  const { Type } = await import("typebox");
  return {
    name: "get_weather",
    label: "Get weather",
    description: "Get the current weather for a city.",
    parameters: Type.Object({ city: Type.String() }),
    execute: async (_id, params) => {
      const city = (params as { city: string }).city;
      log.calls.push(city);
      if (fail || failFor.includes(city)) {
        throw new Error(`Weather service unavailable for ${city}`);
      }
      return {
        content: [
          { type: "text", text: `${city}: clear` },
          { type: "text", text: "25°C, wind 10 km/h" },
        ],
        details: {},
      };
    },
  };
}

/** A second tool a session switches on mid-conversation, as an MCP tool loads on first use. */
export async function timeTool(): Promise<ToolDefinition> {
  const { Type } = await import("typebox");
  return {
    name: "get_time",
    label: "Get time",
    description: "Get the local time in a city.",
    parameters: Type.Object({ city: Type.String() }),
    execute: async (_id, params) => ({
      content: [
        { type: "text", text: `${(params as { city: string }).city}: 09:00` },
      ],
      details: {},
    }),
  };
}

export interface SessionOptions {
  tools: ToolDefinition[];
  /** The scenario, named in the prompt so its cache is its own. */
  cell?: string;
  /** Names active at start; default every tool. */
  activeTools?: string[];
  prompt?: string;
  extensions?: ExtensionFactory[];
  thinkingLevel?: ThinkingLevel;
}

export interface LiveSession {
  session: AgentSession;
  calls: ProviderCall[];
  conversationId: string;
  /** Pi's session id, which OpenAI's cache key and OpenRouter's routing read. */
  sessionId: string;
  dispose(): void;
}

let sessionCount = 0;

/**
 * Number sessions from 1 again. Pi's session id reaches the request body
 * (OpenAI's `prompt_cache_key`), so a cassette matches only the same ids.
 */
export function resetSessionIds(): void {
  sessionCount = 0;
}

/**
 * A real session with nothing read from disk but the options: no skills,
 * context files or settings, and Anthropic message threads off so every
 * request is whole (a gateway forwards no `thread`, which is what a hosted
 * runtime sees). `sessionId` reuses an earlier session's id, as a restore
 * must: OpenAI's `prompt_cache_key` and OpenRouter's session affinity are
 * derived from it.
 */
export async function startSession(
  tracing: PiTracing,
  route: Route,
  opts: SessionOptions,
  sessionId?: string,
): Promise<LiveSession> {
  const {
    createAgentSession,
    DefaultResourceLoader,
    SessionManager,
    SettingsManager,
  } = await import("@earendil-works/pi-coding-agent");
  const { getBuiltinModel } =
    await import("@earendil-works/pi-ai/providers/all");
  mkdirSync(`${CWD}/.agent`, { recursive: true });

  const builtin = builtinModel(getBuiltinModel, route);
  if (!builtin) throw new Error(`Pi has no ${route.provider}/${route.model}`);
  const model =
    route.provider === "anthropic"
      ? {
          ...builtin,
          baseUrl: "https://api.anthropic.com",
          compat: { ...builtin.compat, supportsMessageThreads: false },
        }
      : builtin;
  const calls: ProviderCall[] = [];
  const capture: ExtensionFactory = (pi) => {
    pi.on("before_provider_request", (event) => {
      calls.push({
        body: JSON.parse(JSON.stringify(event.payload)) as ProviderRequest,
        cacheRead: 0,
        prompt: 0,
      });
    });
    pi.on("message_end", (event) => {
      const message = event.message;
      const call = calls.at(-1);
      if (message.role !== "assistant" || !call) return;
      if (message.stopReason === "error") {
        call.error = message.errorMessage ?? "error";
      }
      call.cacheRead = message.usage.cacheRead;
      call.prompt =
        message.usage.input +
        message.usage.cacheRead +
        message.usage.cacheWrite;
    });
  };
  const settingsManager = SettingsManager.inMemory({
    cacheWarming: "off",
    compaction: { enabled: false, keepRecentTokens: 1 },
    retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: CWD,
    agentDir: `${CWD}/.agent`,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    // Pi's default prompt names this machine's install paths.
    systemPrompt: "You are a weather assistant. Answer briefly.",
    appendSystemPrompt: [opts.prompt ?? referencePrompt(route, opts.cell)],
    extensionFactories: [capture, ...(opts.extensions ?? [])],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: CWD,
    agentDir: `${CWD}/.agent`,
    model,
    thinkingLevel: opts.thinkingLevel ?? route.thinkingLevel,
    noTools: "builtin",
    customTools: opts.tools,
    resourceLoader,
    sessionManager: SessionManager.inMemory(CWD, {
      id:
        sessionId ??
        `00000000-0000-7000-8000-${String(sessionCount + 1).padStart(12, "0")}`,
    }),
    settingsManager,
  });
  if (opts.activeTools) session.setActiveToolsByName(opts.activeTools);

  sessionCount += 1;
  const conversationId = `pi-restore-${sessionCount}`;
  const handle = instrumentSession(session, {
    tracer: tracing.provider.getTracer("pi-restore"),
    meta: { conversationId, agentId: conversationId, agentName: "Weather" },
  });
  return {
    session,
    calls,
    conversationId,
    sessionId: session.sessionId,
    dispose: () => {
      handle.detach();
      session.dispose();
    },
  };
}

type Lookup = (provider: string, model: string) => Model<Api> | undefined;

/** The route's model from Pi's catalog, which types its lookup by literal ids. */
export function builtinModel(
  getBuiltinModel: unknown,
  route: Route,
): Model<Api> | undefined {
  return (getBuiltinModel as Lookup)(route.provider, route.model);
}

/** What a restore reads from a conversation's chat spans. */
export interface RestoreInput {
  inputMessages: InputMessage[];
  toolLoadouts: RecordedToolLoadout[];
}

/**
 * The latest chat span's input and output messages, and the tool loadout of
 * every chat span on the same history: those whose input opens with the
 * same message, so a compaction's summary request and the requests before
 * the compaction are left out.
 */
export async function restoreInput(
  tracing: PiTracing,
  conversationId: string,
): Promise<RestoreInput> {
  await tracing.provider.forceFlush();
  const chats = tracing
    .spansFor("chat")
    .filter(
      (span) => span.attributes["gen_ai.conversation.id"] === conversationId,
    )
    .sort((a, b) => hrtime(a) - hrtime(b));
  const last = chats.at(-1);
  if (!last) throw new Error(`no chat span for ${conversationId}`);
  const inputs = json<InputMessage[]>(last, "gen_ai.input.messages");
  const opening = JSON.stringify(inputs[0]);
  return {
    inputMessages: [
      ...inputs,
      ...json<OutputMessage[]>(last, "gen_ai.output.messages").map(
        (message) => ({ ...message, parts: message.parts ?? [] }),
      ),
    ],
    toolLoadouts: chats.flatMap((span) => {
      const messages = json<InputMessage[]>(span, "gen_ai.input.messages");
      if (JSON.stringify(messages[0]) !== opening) return [];
      const tools =
        json<{ name: string }[] | undefined>(span, "gen_ai.tool.definitions") ??
        [];
      return [
        {
          inputMessageCount: messages.length,
          toolNames: tools.map((tool) => tool.name),
        },
      ];
    }),
  };
}

function json<T>(span: ReadableSpan, key: string): T {
  const raw = span.attributes[key];
  return (typeof raw === "string" ? JSON.parse(raw) : undefined) as T;
}

function hrtime(span: ReadableSpan): number {
  return span.startTime[0] * 1e9 + span.startTime[1];
}

/** The request with its cache breakpoints removed: what the provider's cache keys on. */
function cacheKey(body: ProviderRequest): ProviderRequest {
  return JSON.parse(
    JSON.stringify(body, (key, value: unknown) =>
      key === "cache_control" ? undefined : value,
    ),
  ) as ProviderRequest;
}

type Item = { role?: string; type?: string; content?: unknown };

/**
 * A request as the provider's cache reads it, oldest first: its tools, its
 * leading instructions, then the conversation items. Anthropic Messages
 * sends `system` and `messages`; OpenAI Responses sends one `input` list
 * opening with the instructions.
 */
function shape(body: ProviderRequest): {
  tools: unknown;
  system: unknown;
  items: Item[];
} {
  const key = cacheKey(body);
  if (Array.isArray(key.input)) {
    const input = key.input as Item[];
    const lead = input.findIndex(
      (item) => item.role !== "developer" && item.role !== "system",
    );
    const split = lead === -1 ? input.length : lead;
    return {
      tools: key.tools,
      system: [key.prompt_cache_key, input.slice(0, split)],
      items: input.slice(split),
    };
  }
  return {
    tools: key.tools,
    system: key.system,
    items: (key.messages as Item[] | undefined) ?? [],
  };
}

/**
 * How far `next` repeats `previous` where the provider's cache keys: tools,
 * instructions, and the leading conversation items. The effort item a
 * request ends with is that request's own, not history.
 */
export function sharedPrefix(
  previous: ProviderRequest,
  next: ProviderRequest,
): { tools: boolean; system: boolean; messages: number; of: number } {
  const a = shape(previous);
  const b = shape(next);
  const history = isEffortItem(a.items.at(-1)) ? a.items.slice(0, -1) : a.items;
  let messages = 0;
  while (
    messages < history.length &&
    JSON.stringify(history[messages]) === JSON.stringify(b.items[messages])
  ) {
    messages += 1;
  }
  return {
    tools: JSON.stringify(a.tools) === JSON.stringify(b.tools),
    system: JSON.stringify(a.system) === JSON.stringify(b.system),
    messages,
    of: history.length,
  };
}

function isEffortItem(item: Item | undefined): boolean {
  if (item?.type === "configuration_update") return true;
  return (
    item?.role === "system" &&
    Array.isArray(item.content) &&
    item.content.length === 0
  );
}
