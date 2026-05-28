/**
 * AI SDK First-Party Integration Example
 *
 * Demonstrates:
 * - Multi-turn conversation with conversation ID linking across all turns
 * - Anthropic prompt caching via a ≥1024-token system prompt marked with
 *   cache_control — turns 2+ read from cache instead of re-processing it
 * - Tool use across multiple turns (getWeather + getForecast)
 * - cache_creation_input_tokens / cache_read_input_tokens in telemetry
 *
 * Run with: pnpm ai-sdk
 */

import { setupTracing } from "@introspection-sdk/introspection-node/otel";
import { generateText, stepCountIs, tool } from "ai";
import type { ModelMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { randomUUID } from "crypto";
import { z } from "zod";

const WEATHER_DATA: Record<
  string,
  { conditions: string; temp: number; humidity: number }
> = {
  Tokyo: { conditions: "Partly Cloudy", temp: 22, humidity: 65 },
  Paris: { conditions: "Rainy", temp: 14, humidity: 82 },
  Boston: { conditions: "Sunny", temp: 18, humidity: 55 },
  Sydney: { conditions: "Clear", temp: 26, humidity: 48 },
};

const FORECAST_DATA: Record<string, string> = {
  Tokyo: "Day 1: Partly Cloudy 22°C | Day 2: Sunny 24°C | Day 3: Clear 26°C",
  Paris: "Day 1: Rainy 14°C | Day 2: Overcast 16°C | Day 3: Partly Cloudy 18°C",
  Boston: "Day 1: Sunny 18°C | Day 2: Windy 15°C | Day 3: Sunny 20°C",
  Sydney: "Day 1: Clear 26°C | Day 2: Sunny 28°C | Day 3: Partly Cloudy 24°C",
};

const getWeather = tool({
  description:
    "Get current weather conditions for a city, including temperature, conditions, and humidity.",
  inputSchema: z.object({
    city: z.string().describe("The city to get weather for"),
  }),
  execute: async ({ city }) => {
    const data = WEATHER_DATA[city];
    if (!data) return `No weather data available for ${city}.`;
    return `${city}: ${data.conditions}, ${data.temp}°C (${Math.round((data.temp * 9) / 5 + 32)}°F), humidity ${data.humidity}%.`;
  },
});

const getForecast = tool({
  description: "Get a 3-day weather forecast for a city.",
  inputSchema: z.object({
    city: z.string().describe("The city to get a forecast for"),
  }),
  execute: async ({ city }) => {
    const forecast = FORECAST_DATA[city];
    if (!forecast) return `No forecast available for ${city}.`;
    return `3-day forecast for ${city}: ${forecast}`;
  },
});

// System prompt must be ≥1024 tokens and marked with cache_control to trigger
// Anthropic prompt caching. The cache_control breakpoint tells Anthropic to
// cache everything up to and including this block. Turns 2–4 will then read
// from cache instead of re-processing the system prompt.
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

async function runTurn(
  userMessage: string,
  history: ModelMessage[],
  conversationId: string,
): Promise<{ text: string; responseMessages: ModelMessage[] }> {
  const messages: ModelMessage[] = [
    {
      role: "system",
      content: SYSTEM_PROMPT,
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral" } },
      },
    },
    ...history,
    { role: "user", content: userMessage },
  ];

  const result = await generateText({
    model: anthropic("claude-sonnet-4-20250514"),
    messages,
    tools: { getWeather, getForecast },
    stopWhen: stepCountIs(3),
    experimental_telemetry: {
      isEnabled: true,
      functionId: "weather-agent",
      metadata: {
        "gen_ai.conversation.id": conversationId,
      },
    },
  });

  return {
    text: result.text,
    // response.messages contains the full assistant turn including any tool
    // calls and tool results so subsequent turns have complete context.
    responseMessages: result.response.messages as ModelMessage[],
  };
}

async function main() {
  // Registers the global OTel provider with IntrospectionSpanProcessor —
  // the AI SDK's `experimental_telemetry: { isEnabled: true }` uses it.
  // The processor's onEnd handler runs convertVercelAIToGenAI to map
  // `ai.*` → `gen_ai.*` for any AI SDK span that flows through.
  const provider = setupTracing({ serviceName: "ai-sdk-example" });

  const conversationId = randomUUID();
  console.log("Conversation ID:", conversationId);

  const history: ModelMessage[] = [];

  // Turn 1: fetch current conditions via tool (cache_creation_input_tokens logged)
  console.log("\n=== Turn 1: Current conditions in Tokyo ===");
  const q1 = "What is the weather in Tokyo right now?";
  const { text: a1, responseMessages: r1 } = await runTurn(
    q1,
    history,
    conversationId,
  );
  console.log(`Q: ${q1}`);
  console.log(`A: ${a1}`);
  history.push({ role: "user", content: q1 }, ...r1);

  // Turn 2: compare with a second city — system prompt served from cache
  console.log(
    "\n=== Turn 2: Compare with Paris (cache hit on system prompt) ===",
  );
  const q2 = "How does that compare to Paris right now?";
  const { text: a2, responseMessages: r2 } = await runTurn(
    q2,
    history,
    conversationId,
  );
  console.log(`Q: ${q2}`);
  console.log(`A: ${a2}`);
  history.push({ role: "user", content: q2 }, ...r2);

  // Turn 3: use the second tool (getForecast) for the better-weather city
  console.log("\n=== Turn 3: 3-day forecast with second tool ===");
  const q3 =
    "Can you get the 3-day forecast for whichever city has better weather?";
  const { text: a3, responseMessages: r3 } = await runTurn(
    q3,
    history,
    conversationId,
  );
  console.log(`Q: ${q3}`);
  console.log(`A: ${a3}`);
  history.push({ role: "user", content: q3 }, ...r3);

  // Turn 4: final reasoning over full conversation history, no new tool call needed
  console.log("\n=== Turn 4: Recommendation reasoning over full history ===");
  const q4 =
    "Based on everything so far, which city would you recommend for an outdoor event this weekend, and why?";
  const { text: a4 } = await runTurn(q4, history, conversationId);
  console.log(`Q: ${q4}`);
  console.log(`A: ${a4}`);

  await provider.shutdown();
  console.log("\nDone — spans exported to Introspection.");
}

main().catch(console.error);
