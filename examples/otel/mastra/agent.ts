/**
 * Mastra AI SDK Example — Anthropic with prompt caching
 *
 * Demonstrates using IntrospectionMastraExporter with a multi-turn Anthropic
 * agent. The ≥1024-token system prompt is marked with cache_control so:
 *   Turn 1 → cache_creation_input_tokens (cache write)
 *   Turn 2 → cache_read_input_tokens (cache hit)
 *
 * Run with: pnpm mastra-ai
 *
 * Required env: ANTHROPIC_API_KEY, INTROSPECTION_TOKEN
 */

import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { Observability } from "@mastra/observability";
import { IntrospectionMastraExporter } from "@introspection-sdk/introspection-node/mastra";
import { anthropic } from "@ai-sdk/anthropic";
import { randomUUID } from "crypto";
import { z } from "zod";

// ── System prompt (≥1024 tokens) with cache_control applied below ────────────
const SYSTEM_PROMPT = `You are a professional meteorological assistant with deep expertise in global weather patterns, climate science, and atmospheric dynamics. Your role is to provide accurate, concise, and actionable weather information to users around the world.

You always use the available tools to fetch real-time data before answering weather queries. Never guess or fabricate weather conditions — always call the relevant tool first.

Background knowledge (cached for performance):
Meteorology is the scientific study of the atmosphere, focusing on weather processes and forecasting. Weather phenomena include temperature, humidity, precipitation, cloudiness, visibility, and wind patterns.

Temperature is measured in Celsius (°C) in most countries, or Fahrenheit (°F) in the United States. To convert: F = C × 9/5 + 32. Standard body temperature is 37°C (98.6°F). Water freezes at 0°C (32°F) and boils at 100°C (212°F).

Relative humidity is the amount of moisture in the air relative to the maximum amount the air can hold at that temperature. High humidity (above 70%) combined with high temperature creates uncomfortable conditions and elevates the heat index.

Precipitation includes rain, snow, sleet, freezing rain, and hail — all forms of water or ice falling from clouds. Rainfall is measured in millimeters per hour. Heavy rainfall is defined as more than 7.6 mm/hour.

Wind speed is measured in km/h, mph, m/s, or nautical knots. The Beaufort scale rates wind strength from 0 (calm) to 12 (hurricane force, ≥117 km/h). Wind direction is expressed as the compass direction from which the wind originates.

Cloud cover is measured in oktas — eighths of the sky covered by clouds. 0 oktas = perfectly clear; 8 oktas = completely overcast. Clouds are classified by altitude: low (stratus, cumulus), mid (altostratus, altocumulus), and high (cirrus, cirrostratus).

Atmospheric pressure is measured in hectopascals (hPa) or millibars (mb). Mean sea-level pressure is 1013.25 hPa. High-pressure systems (anticyclones) generally produce stable, fair weather. Low-pressure systems (depressions) produce unstable, cloudy, and rainy conditions.

A front is the boundary between two different air masses. Cold fronts typically bring a narrow band of heavy rain followed by clearing skies and falling temperatures. Warm fronts produce a wide zone of prolonged, steady rain ahead of the front.

The dew point is the temperature at which air becomes saturated with water vapour and condensation begins. When the dew point equals the air temperature, relative humidity is 100% and fog or clouds form.

UV index measures ultraviolet radiation intensity from the sun. Values of 3–5 require sun protection during peak hours; 6+ requires sun protection at all times outdoors. UV index above 11 represents extreme risk.

Visibility is measured in metres or kilometres and can be reduced by fog, mist, haze, smoke, rain, or blowing snow. Fog is defined as visibility below 1 km; mist is 1–5 km.

Fog forms when the air cools to its dew point near the ground. Radiation fog forms on calm, clear nights as the ground loses heat; it typically dissipates after sunrise. Advection fog forms when warm, moist air moves over a cooler surface.

Thunderstorms require three ingredients: moisture, lift, and atmospheric instability. They produce lightning, heavy rain, gusty winds, and sometimes large hail. Lightning strikes the ground roughly 100 times per second globally.

The jet stream is a narrow, fast-flowing ribbon of air in the upper troposphere, typically 9–12 km above the surface. It steers mid-latitude weather systems and can reach speeds of 400 km/h.

El Niño is a periodic warming of the central and eastern tropical Pacific Ocean that disrupts normal weather patterns globally. La Niña is the opposite phase, with cooler-than-average sea surface temperatures. Together they form the El Niño–Southern Oscillation (ENSO) cycle.

Climate differs from weather: weather is the day-to-day state of the atmosphere; climate is the average weather over a 30-year reference period. Climate change refers to long-term shifts in global temperatures and weather patterns, driven primarily by human greenhouse-gas emissions since the mid-20th century.

Provide clear, factual, and helpful responses. When discussing temperature, always state it in both Celsius and Fahrenheit for international users. When discussing wind, include the Beaufort scale classification where relevant.`;

// ── Observability setup ───────────────────────────────────────────────────────
const observability = new Observability({
  configs: {
    otel: {
      serviceName: "mastra-ai-example",
      exporters: [new IntrospectionMastraExporter()],
    },
  },
});

const mastra = new Mastra({ observability });

// ── Tool ─────────────────────────────────────────────────────────────────────
const WEATHER_DATA: Record<string, string> = {
  Tokyo: "Partly Cloudy, 22°C",
  Paris: "Rainy, 14°C",
  Boston: "Sunny, 18°C",
};

const getWeatherTool = {
  name: "get_weather",
  description:
    "Get the current weather for a city. Returns conditions and temperature.",
  parameters: z.object({
    city: z.string().describe("The city name"),
  }),
  execute: async ({ city }: { city: string }) => {
    return WEATHER_DATA[city] ?? `No data for ${city}`;
  },
};

// ── Agent ─────────────────────────────────────────────────────────────────────
// Mastra requires a non-empty `instructions` string (crashes otherwise).
// We set a minimal placeholder; the real cached system prompt is passed
// per-call in the messages array below so we can attach providerOptions.
const agent = new Agent({
  id: "weather-assistant",
  name: "weather-assistant",
  instructions: "You are a weather assistant.",
  model: anthropic("claude-sonnet-4-6"),
  tools: { get_weather: getWeatherTool },
  mastra,
});

// System message with cache_control — the providerOptions propagate through
// Mastra's AIV5 message pipeline and arrive at the Anthropic adapter intact.
const SYSTEM_MESSAGE = {
  role: "system" as const,
  content: SYSTEM_PROMPT,
  providerOptions: {
    anthropic: { cacheControl: { type: "ephemeral" as const } },
  },
};

type HistoryMessage = { role: "user" | "assistant"; content: string };
type AgentGenerateInput = Parameters<typeof agent.generate>[0];

async function runTurn(
  userMsg: string,
  history: HistoryMessage[],
  conversationId: string,
): Promise<string> {
  const messages = [
    SYSTEM_MESSAGE,
    ...history,
    { role: "user" as const, content: userMsg },
  ] as unknown as AgentGenerateInput;
  const result = await agent.generate(messages, {
    tracingOptions: { metadata: { "gen_ai.conversation.id": conversationId } },
  });
  return result.text;
}

async function main() {
  console.log("Running Mastra agent with Anthropic + prompt caching...\n");

  const conversationId = randomUUID();
  console.log("Conversation ID:", conversationId);

  const history: HistoryMessage[] = [];

  // Turn 1 — cache_creation_input_tokens expected (system prompt written to cache)
  console.log("=== Turn 1: Weather lookup (cache write) ===");
  const q1 = "What's the weather in Tokyo right now?";
  const a1 = await runTurn(q1, history, conversationId);
  console.log(`Q: ${q1}`);
  console.log(`A: ${a1}\n`);
  history.push(
    { role: "user", content: q1 },
    { role: "assistant", content: a1 },
  );

  // Turn 2 — cache_read_input_tokens expected (system prompt served from cache)
  console.log("=== Turn 2: Follow-up (cache hit on system prompt) ===");
  const q2 = "How does that compare to Paris right now?";
  const a2 = await runTurn(q2, history, conversationId);
  console.log(`Q: ${q2}`);
  console.log(`A: ${a2}\n`);

  await observability.shutdown();
  console.log("Done — spans exported to Introspection.");
}

main().catch(console.error);
