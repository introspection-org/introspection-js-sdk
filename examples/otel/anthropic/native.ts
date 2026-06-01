/**
 * Anthropic Native Instrumentation Example
 *
 * Uses Introspection's AnthropicInstrumentor to capture the full Anthropic response
 * including thinking blocks (extended thinking) with signatures. Demonstrates
 * multi-turn conversation where thinking blocks are replayed in the history
 * and the model reasons over previous outputs.
 *
 * Run with: pnpm anthropic-native
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ThinkingConfigEnabled,
  Tool,
} from "@anthropic-ai/sdk/resources/messages";
import {
  AnthropicInstrumentor,
  IntrospectionSpanProcessor,
} from "@introspection-sdk/introspection-node/otel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

function getWeather(city: string): string {
  const data: Record<string, string> = {
    Tokyo: "Clear, 25°C",
    Paris: "Rainy, 12°C",
  };
  return data[city] || `No data for ${city}`;
}

async function main() {
  const processor = new IntrospectionSpanProcessor({
    serviceName: "anthropic-native-example",
  });
  const provider = new NodeTracerProvider({
    spanProcessors: [processor],
  });
  provider.register();

  const client = new Anthropic();
  const instrumentor = new AnthropicInstrumentor();
  instrumentor.instrument({ tracerProvider: provider, client });
  const tools: Tool[] = [
    {
      name: "get_weather",
      description:
        "Get weather for a city. Returns conditions and temperature in Celsius.",
      input_schema: {
        type: "object" as const,
        properties: {
          city: { type: "string", description: "City name" },
        },
        required: ["city"],
      },
    },
  ];

  const model = "claude-sonnet-4-6";

  // System prompt must be ≥1024 tokens and marked with cache_control to trigger
  // Anthropic prompt caching. The cache_control breakpoint tells Anthropic to
  // cache everything up to (and including) this block. Turns 2 and 3 will then
  // read from cache instead of re-processing the system prompt.
  const system = [
    {
      type: "text" as const,
      text: `You are a helpful weather assistant. Always use the tool to get weather data. Be concise.

Background knowledge (cached):
Meteorology is the scientific study of the atmosphere that focuses on weather processes and forecasting.
Weather phenomena include temperature, humidity, precipitation, cloudiness, visibility, and wind.
Temperature is measured in Celsius (°C) or Fahrenheit (°F). To convert: F = C × 9/5 + 32.
Relative humidity is the amount of moisture in the air relative to the maximum amount the air can hold at that temperature.
Precipitation includes rain, snow, sleet, and hail — all forms of water falling from clouds.
Wind speed is measured in km/h, mph, or knots. Wind direction is given as the direction the wind is coming from.
Cloud cover is measured in oktas (eighths of sky covered). 0 oktas = clear sky, 8 oktas = fully overcast.
Atmospheric pressure is measured in hectopascals (hPa) or millibars (mb). Standard pressure is 1013.25 hPa.
High pressure systems (anticyclones) generally bring fair, settled weather.
Low pressure systems (cyclones or depressions) generally bring cloud, rain, and strong winds.
A front is the boundary between two different air masses. Cold fronts bring rain then clearing; warm fronts bring prolonged rain.
The dew point is the temperature at which air becomes saturated and condensation begins.
UV index measures the intensity of ultraviolet radiation from the sun. Values above 6 require sun protection.
Visibility is measured in metres or kilometres and can be reduced by fog, haze, rain, or snow.
Fog forms when air cools to its dew point near the ground. Radiation fog forms on clear calm nights.
Thunderstorms require lift, moisture, and instability. They produce lightning, heavy rain, and sometimes hail.
Tropical cyclones (hurricanes, typhoons) form over warm ocean water and are characterised by strong winds and heavy rain.
The jet stream is a fast-flowing, narrow air current in the upper atmosphere that steers weather systems.
El Niño and La Niña are climate patterns in the Pacific Ocean that affect weather worldwide.
Climate is the average weather over a long period (typically 30 years). Weather is the short-term state of the atmosphere.
Seasons are caused by the tilt of Earth's axis relative to its orbit around the sun.
The troposphere extends from the surface to about 12 km altitude and is where weather occurs.
Radiosonde balloons measure temperature, humidity, and pressure through the atmosphere twice daily worldwide.
Weather satellites provide images of cloud cover, sea surface temperature, and storm systems from orbit.
Doppler radar measures precipitation intensity and wind speed inside weather systems.
Numerical weather prediction uses mathematical models of the atmosphere run on supercomputers.
Ensemble forecasting runs many slightly different model initialisations to quantify forecast uncertainty.
The Beaufort scale rates wind strength from 0 (calm) to 12 (hurricane-force).
Heat index combines temperature and humidity to indicate how hot it feels to the human body.
Wind chill factor combines temperature and wind speed to indicate how cold it feels on exposed skin.
Growing degree days accumulate heat above a threshold temperature to track crop development.
Marine forecasts include sea state, wave height, swell period, and visibility for maritime users.`,
      cache_control: { type: "ephemeral" as const },
    },
  ];

  const thinkingConfig: ThinkingConfigEnabled = {
    type: "enabled",
    budget_tokens: 5000,
  };
  const messages: MessageParam[] = [
    { role: "user", content: "What's the weather in Tokyo?" },
  ];

  // Turn 1: Thinking + Tool Call
  console.log("=== Turn 1: Thinking + Tool Call ===");
  const response1 = await client.messages.create({
    model,
    max_tokens: 8000,
    system,
    thinking: thinkingConfig,
    tools,
    messages,
  });

  for (const block of response1.content) {
    if (block.type === "thinking") {
      console.log(`  [Thinking] ${block.thinking.slice(0, 80)}...`);
    } else if (block.type === "tool_use") {
      console.log(`  [Tool] ${block.name}(${JSON.stringify(block.input)})`);
    }
  }

  messages.push({ role: "assistant", content: response1.content });

  const toolUseBlock = response1.content.find((b) => b.type === "tool_use");
  if (!toolUseBlock || toolUseBlock.type !== "tool_use")
    throw new Error("Expected tool_use");
  const toolResult = getWeather(
    (toolUseBlock.input as Record<string, string>).city,
  );
  console.log(`  [Result] ${toolResult}`);
  messages.push({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseBlock.id,
        content: toolResult,
      },
    ],
  });

  // Turn 2: Tool Result → Model Summarizes
  console.log("\n=== Turn 2: Tool Result → Model Summarizes ===");
  const response2 = await client.messages.create({
    model,
    max_tokens: 8000,
    system,
    thinking: thinkingConfig,
    tools,
    messages,
  });

  for (const block of response2.content) {
    if (block.type === "thinking") {
      console.log(`  [Thinking] ${block.thinking.slice(0, 80)}...`);
    } else if (block.type === "text") {
      console.log(`  [Response] ${block.text.slice(0, 200)}`);
    }
  }

  messages.push({ role: "assistant", content: response2.content });

  // Turn 3: Follow-up — model reasons over previous output
  console.log(
    "\n=== Turn 3: Follow-up — model reasons over previous output ===",
  );
  messages.push({
    role: "user",
    content:
      "What is that temperature in Fahrenheit? And should I bring a jacket?",
  });

  const response3 = await client.messages.create({
    model,
    max_tokens: 8000,
    system,
    thinking: thinkingConfig,
    tools,
    messages,
  });

  for (const block of response3.content) {
    if (block.type === "thinking") {
      console.log(`  [Thinking] ${block.thinking.slice(0, 80)}...`);
    } else if (block.type === "text") {
      console.log(`  [Response] ${block.text.slice(0, 200)}`);
    }
  }

  instrumentor.uninstrument();
  await processor.forceFlush();
  await provider.shutdown();
  console.log("\n✓ All turns completed. Thinking blocks captured in traces.");
}

main().catch(console.error);
