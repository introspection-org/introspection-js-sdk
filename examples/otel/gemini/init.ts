/**
 * Gemini one-liner example: `introspection.init()` auto-detects Gemini.
 *
 * A single `introspection.init()` call patches the installed `@google/genai`
 * SDK (capturing thought signatures — encrypted reasoning-state tokens that
 * Gemini 3.x attaches to text/function-call parts) and wires it into
 * Introspection's trace pipeline. Contrast with `gemini-native.ts`, which shows
 * the explicit standalone `GeminiInstrumentor` path.
 *
 * Run with:
 *   export INTROSPECTION_TOKEN=...
 *   export GEMINI_API_KEY=...
 *   pnpm gemini-init
 */

import { GoogleGenAI } from "@google/genai";
import * as introspection from "@introspection-sdk/introspection-node/otel";

async function main() {
  // One line: detects @google/genai (and any other installed framework).
  await introspection.init({ serviceName: "gemini-init-example" });

  // Constructed AFTER init() — auto-traced, no per-client wiring.
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  await introspection.conversation(async () => {
    const response = await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "What is 2+2? Think step by step.",
      config: {
        thinkingConfig: { thinkingBudget: 2048, includeThoughts: true },
      },
    });
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (part.text && !part.thought) console.log(`  [Response] ${part.text}`);
    }
  });

  await introspection.shutdown();
  console.log("\n✓ Completed. Thought signatures captured in traces.");
}

main().catch(console.error);
