/**
 * Gemini SDK + Langfuse dual export — the explicit, bring-your-own-provider
 * form.
 *
 * You construct the OTel `NodeTracerProvider` yourself with the Introspection
 * processor next to the Langfuse one, register it, then `init({ tracerProvider })`
 * adopts it and arms the `@google/genai` prototype-patch auto-instrumentation.
 * Every `generateContent` span fans out to both backends.
 *
 * The IntrospectionSpanProcessor forwards its own converted copy to
 * Introspection; the Langfuse processor receives the raw span — order is
 * irrelevant.
 *
 * Run with: pnpm gemini-langfuse
 *
 * Required env vars:
 *   GEMINI_API_KEY        - Google Gemini API key
 *   INTROSPECTION_TOKEN   - Introspection API token
 *   LANGFUSE_PUBLIC_KEY   - Langfuse public key
 *   LANGFUSE_SECRET_KEY   - Langfuse secret key
 */

import { GoogleGenAI } from "@google/genai";
import * as introspection from "@introspection-sdk/introspection-node/otel";
import { IntrospectionSpanProcessor } from "@introspection-sdk/introspection-node/otel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

import { langfuseSpanProcessor } from "../../_shared/dual-export";

async function main() {
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "gemini-langfuse",
    }),
    spanProcessors: [
      new IntrospectionSpanProcessor({
        token: process.env.INTROSPECTION_TOKEN,
      }),
      langfuseSpanProcessor(),
    ],
  });
  provider.register();

  await introspection.init({ tracerProvider: provider });

  // Constructed AFTER init() — auto-traced via the prototype patch.
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  await introspection.conversation(async () => {
    const response = await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "Say hello in one word.",
    });
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (part.text && !part.thought) console.log(part.text);
    }
  });

  await introspection.shutdown();
  console.log("✓ Exported to Introspection + Langfuse.");
}

main().catch(console.error);
