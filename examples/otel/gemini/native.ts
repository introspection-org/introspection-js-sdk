/**
 * Gemini Native Instrumentation Example
 *
 * Uses Introspection's `GeminiInstrumentor` to capture the full
 * `@google/genai` response — including thought summaries (`thought: true`)
 * AND the per-part `thoughtSignature` payloads that Gemini 2.5+ / 3.x emits
 * around tool calls. Third-party instrumentors typically drop those, which
 * breaks multi-turn chains because Google requires signatures to be replayed
 * on subsequent turns to preserve the model's reasoning state.
 *
 * @see https://ai.google.dev/gemini-api/docs/thought-signatures
 *
 * What this example demonstrates:
 *   • One-line opt-in:        new GeminiInstrumentor().instrument({ client })
 *   • Single-turn capture:    thought summary + visible answer
 *   • Multi-turn replay:      preserve thoughtSignature across turns so the
 *                             model maintains its chain of thought
 *   • Streaming:              generateContentStream is aggregated by chunk
 *
 * Run with: pnpm gemini-native
 *
 * Required env: GEMINI_API_KEY, INTROSPECTION_TOKEN
 */

import { GoogleGenAI, Type, type Content } from "@google/genai";
import {
  GeminiInstrumentor,
  IntrospectionSpanProcessor,
} from "@introspection-sdk/introspection-node/otel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Set up the OTel tracer provider with the Introspection span processor.
//    Do this once at application startup.
// ─────────────────────────────────────────────────────────────────────────────

const processor = new IntrospectionSpanProcessor({
  serviceName: "gemini-native-example",
  // token: process.env.INTROSPECTION_TOKEN, // picked up automatically
});
const provider = new NodeTracerProvider({ spanProcessors: [processor] });
provider.register();

// ─────────────────────────────────────────────────────────────────────────────
// 2. Create a `@google/genai` client and patch it with `GeminiInstrumentor`.
//    The patch wraps `client.models.generateContent` and
//    `client.models.generateContentStream` to emit gen_ai spans.
// ─────────────────────────────────────────────────────────────────────────────

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const instrumentor = new GeminiInstrumentor();
instrumentor.instrument({ tracerProvider: provider, client });

// A toy local tool. Real apps would call into a database, an API, etc.
function getWeather(city: string): {
  conditions: string;
  temperature_c: number;
} {
  const data: Record<string, { conditions: string; temperature_c: number }> = {
    Tokyo: { conditions: "Clear", temperature_c: 25 },
    Paris: { conditions: "Rainy", temperature_c: 12 },
  };
  return data[city] ?? { conditions: "Unknown", temperature_c: NaN };
}

const tools = [
  {
    functionDeclarations: [
      {
        name: "get_weather",
        description:
          "Get the current weather for a city. Returns conditions and temperature in Celsius.",
        parameters: {
          type: Type.OBJECT,
          properties: { city: { type: Type.STRING, description: "City name" } },
          required: ["city"],
        },
      },
    ],
  },
];

const MODEL = "gemini-2.5-flash";
const thinkingConfig = { thinkingBudget: 2048, includeThoughts: true };

async function main() {
  // ───────────────────────────────────────────────────────────────────────────
  // Single-turn: capture thought summary + visible answer
  // ───────────────────────────────────────────────────────────────────────────

  console.log("=== Single-turn: thinking + answer ===");
  const single = await client.models.generateContent({
    model: MODEL,
    contents: "What is 2+2? Think step by step.",
    config: { thinkingConfig },
  });
  for (const part of single.candidates?.[0]?.content?.parts ?? []) {
    if (part.thought) {
      console.log(`  [Thought] ${(part.text || "").slice(0, 80)}...`);
    } else if (part.text) {
      console.log(`  [Answer]  ${part.text.slice(0, 200)}`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Multi-turn with tool use — REQUIRES preserving thoughtSignature across turns
  //
  // The model attaches `thoughtSignature` to the `functionCall` part of turn 1.
  // To continue the conversation, append the model's *entire* `content.parts`
  // array back into `contents` AS-IS. Do NOT strip or modify the parts — the
  // signature is what lets the model maintain its chain of thought.
  // ───────────────────────────────────────────────────────────────────────────

  console.log("\n=== Multi-turn: tool call → tool result → answer ===");
  const contents: Content[] = [
    { role: "user", parts: [{ text: "What is the weather in Tokyo?" }] },
  ];

  // Turn 1: model emits a thought summary + functionCall (carrying thoughtSignature)
  const turn1 = await client.models.generateContent({
    model: MODEL,
    contents,
    config: { tools, thinkingConfig },
  });

  const turn1Parts = turn1.candidates?.[0]?.content?.parts ?? [];
  const fnCallPart = turn1Parts.find((p) => p.functionCall);
  if (!fnCallPart?.functionCall?.name)
    throw new Error("Expected a function call");
  console.log(
    `  [Turn 1] tool_call=${fnCallPart.functionCall.name}(${JSON.stringify(
      fnCallPart.functionCall.args,
    )})`,
  );
  if (fnCallPart.thoughtSignature) {
    console.log(
      `  [Turn 1] thoughtSignature=${fnCallPart.thoughtSignature.slice(0, 24)}... (${fnCallPart.thoughtSignature.length} chars)`,
    );
  }

  // Execute the tool locally and append both the assistant turn AND the
  // function response back to `contents`. Replaying `turn1Parts` verbatim is
  // what carries the thoughtSignature into the next request.
  const toolResult = getWeather(
    (fnCallPart.functionCall.args as { city: string }).city,
  );
  contents.push({ role: "model", parts: turn1Parts });
  contents.push({
    role: "user",
    parts: [
      {
        functionResponse: {
          name: fnCallPart.functionCall.name,
          response: toolResult,
        },
      },
    ],
  });

  // Turn 2: model uses the tool result to compose a natural-language answer
  const turn2 = await client.models.generateContent({
    model: MODEL,
    contents,
    config: { tools, thinkingConfig },
  });
  const turn2Text = (turn2.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join("");
  console.log(`  [Turn 2] answer=${turn2Text.trim()}`);

  // ───────────────────────────────────────────────────────────────────────────
  // Streaming: GeminiInstrumentor aggregates chunks so the captured span
  // carries the complete final message — including the final thoughtSignature
  // (which arrives on the last chunk of a streamed block).
  // ───────────────────────────────────────────────────────────────────────────

  console.log("\n=== Streaming ===");
  const stream = await client.models.generateContentStream({
    model: MODEL,
    contents: "Briefly: what is the boiling point of water at sea level?",
    config: { thinkingConfig: { thinkingBudget: 512, includeThoughts: true } },
  });
  let streamedText = "";
  for await (const chunk of stream) {
    for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
      if (part.text && !part.thought) streamedText += part.text;
    }
  }
  console.log(`  [Stream] ${streamedText.trim()}`);

  // ───────────────────────────────────────────────────────────────────────────
  // Always flush + uninstrument on shutdown so spans get exported.
  // ───────────────────────────────────────────────────────────────────────────

  instrumentor.uninstrument();
  await processor.forceFlush();
  await provider.shutdown();
  console.log("\n✓ Spans flushed. Thought signatures captured for replay.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
