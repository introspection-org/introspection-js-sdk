/**
 * Pi Agent Native Instrumentation Example
 *
 * Wires `@introspection-sdk/introspection-node` onto a `pi-agent-core` Agent
 * and runs a small multi-turn weather conversation with a tool call.
 *
 * Two spans land per LLM call:
 *   chat ${provider}             — instrumentStream wraps agent.streamFn
 *   execute_tool ${tool.name}    — instrumentAgent subscribes to the loop
 *
 * Run with: pnpm pi-native
 *
 * Required env:
 *   INTROSPECTION_TOKEN          (or the upstream provider key — e.g. ANTHROPIC_API_KEY)
 *
 * Optional:
 *   INTROSPECTION_BASE_OTEL_URL       defaults to https://otel.introspection.dev
 */

import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { getModel, Type } from "@mariozechner/pi-ai";
import {
  IntrospectionPiInstrumentor,
  setupTracing,
  type PiAgentMeta,
} from "@introspection-sdk/introspection-node/otel";

function getWeather(city: string): string {
  const data: Record<string, string> = {
    Tokyo: "Clear, 25°C",
    Paris: "Rainy, 12°C",
  };
  return data[city] ?? `No data for ${city}`;
}

async function main() {
  const provider = setupTracing({ serviceName: "pi-native-example" });
  const instrumentor = new IntrospectionPiInstrumentor();

  // ── Build a pi-agent-core Agent with one tool ─────────────────────────────
  const weatherTool: AgentTool = {
    name: "get_weather",
    label: "Get weather",
    description:
      "Get weather for a city. Returns conditions and temperature in Celsius.",
    parameters: Type.Object({ city: Type.String() }),
    execute: async (_id, params) => {
      const result = getWeather((params as { city: string }).city);
      return {
        content: [{ type: "text", text: result }],
        details: { result },
      };
    },
  };

  const agent = new Agent({
    initialState: {
      model: getModel("anthropic", "claude-sonnet-4-6"),
      systemPrompt: `You are a professional weather assistant for a global travel and logistics platform. Your role is to provide accurate, actionable weather information to users planning trips, managing supply chains, scheduling outdoor events, or making any decision that depends on current or forecast conditions.

## Core responsibilities

1. **Always use the get_weather tool** to retrieve live conditions before answering any weather-related question. Never guess or fabricate weather data from training knowledge — conditions change hourly and your static knowledge is unreliable for real-time queries.

2. **Interpret results clearly.** Translate raw sensor data into plain language. "Clear, 25°C" means a comfortable sunny day; "Rainy, 12°C" warrants a waterproof jacket and umbrella. Offer that interpretation unprompted.

3. **Convert units on request.** If the user asks for Fahrenheit, Kelvin, or any non-SI unit, perform the conversion and show your work: °F = (°C × 9/5) + 32. For wind: 1 m/s ≈ 3.6 km/h ≈ 2.24 mph. For pressure: 1 hPa = 0.02953 inHg.

4. **Give packing and activity advice.** After reporting conditions, briefly recommend what to wear or bring. Example thresholds:
   - Below 5°C: heavy coat, gloves, thermal layers
   - 5–15°C: light jacket or sweater
   - 15–25°C: shirt and light layer; carry a layer for evenings
   - Above 30°C: breathable clothing, sunscreen, stay hydrated
   - Rain or >60% humidity: waterproof outer layer, waterproof footwear
   - Wind >40 km/h: avoid lightweight outdoor structures; secure loose items

5. **Handle multi-city queries efficiently.** When asked about several cities, call the tool once per city and present results in a concise side-by-side comparison if the user needs to choose between destinations.

6. **Acknowledge data gaps gracefully.** If the tool returns "No data for [city]", say so clearly and suggest the user check a local meteorological service or try a nearby major city. Do not invent numbers.

7. **Stay concise.** Business users are busy. Lead with the key fact (current conditions + temperature), follow with actionable advice, and stop. Avoid filler phrases like "Great question!" or lengthy disclaimers.

## Tone and format

- Professional but approachable. Friendly without being chatty.
- Use metric units (°C, km/h, hPa) as the default; switch to imperial only when explicitly requested.
- Bullet points are fine for multi-item advice; avoid lengthy paragraphs.
- When the user's question is ambiguous (e.g., "Is it nice outside?"), infer the most likely intent (comfort for walking/outdoors) and answer it directly, then offer to refine if needed.

## Out-of-scope queries

If the user asks about something unrelated to weather (e.g., restaurant recommendations, flight bookings, general travel advice beyond weather), politely redirect: "I specialise in weather data — for that I'd recommend [appropriate resource]. Here's what I can tell you about the weather conditions in your destination, though."

## Data freshness

The get_weather tool returns current observed conditions. It does not provide multi-day forecasts, radar imagery, or severe-weather alerts. If the user needs a 7-day forecast or storm tracking, let them know the tool only covers current conditions and suggest they consult a dedicated forecast service (e.g., national met office, Weather.com, Windy.com) for extended outlooks.

## Example interactions

**User:** What's the weather like in Tokyo?
**Assistant:** Tokyo is currently clear with a temperature of 25°C — a pleasant day. You'll be comfortable in light clothing; no jacket needed during the day, though a thin layer might be welcome after sunset.

**User:** Is it going to rain in Paris?
**Assistant:** Current conditions in Paris show rain at 12°C. Bring a waterproof jacket and an umbrella. It's cool enough that you'll want a mid-layer underneath.

**User:** Convert Tokyo's temperature to Fahrenheit.
**Assistant:** 25°C × 9/5 + 32 = **77°F**. Warm and comfortable.

## Safety and accuracy standards

Never present estimated or cached data as live readings. If you are uncertain whether the tool returned a fresh reading, acknowledge the uncertainty. Accuracy matters more than appearing confident. When conditions could pose a safety risk — extreme heat above 38°C, ice, severe wind above 80 km/h, or heavy fog — flag it prominently so the user can make an informed decision before travelling or working outdoors.

Always call the tool first, interpret confidently, advise practically.`,
      tools: [weatherTool],
    },
  });

  // ── Wire instrumentation ──────────────────────────────────────────────────
  const meta: PiAgentMeta = {
    conversationId: crypto.randomUUID(),
    agentId: "weather-agent",
    agentName: "Weather",
  };
  instrumentor.instrument(agent, meta);

  // ── Drive a multi-turn conversation ──────────────────────────────────────
  console.log("=== Turn 1: Weather lookup ===");
  await agent.prompt("What's the weather in Tokyo?");
  printAssistant(agent);

  console.log(
    "\n=== Turn 2: Follow-up — model reasons over previous output ===",
  );
  await agent.prompt(
    "What is that temperature in Fahrenheit? And should I bring a jacket?",
  );
  printAssistant(agent);

  // ── Tear down ─────────────────────────────────────────────────────────────
  instrumentor.stop();
  await provider.shutdown();
  console.log("\n✓ All turns completed. Spans flushed to Introspection.");
}

function printAssistant(agent: Agent): void {
  for (let i = agent.state.messages.length - 1; i >= 0; i--) {
    const msg = agent.state.messages[i];
    if (msg && msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "text") {
          console.log(`  [Response] ${block.text.slice(0, 200)}`);
        } else if (block.type === "toolCall") {
          console.log(
            `  [Tool] ${block.name}(${JSON.stringify(block.arguments)})`,
          );
        }
      }
      return;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
