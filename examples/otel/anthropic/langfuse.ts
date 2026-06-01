/**
 * Anthropic SDK + Langfuse dual export — the explicit, bring-your-own-provider
 * form.
 *
 * You construct the OTel `NodeTracerProvider` yourself and lay out its span
 * processors by hand — the Introspection processor next to the Langfuse one —
 * then register it. `init({ tracerProvider })` adopts that provider (it does not
 * create its own), arms the Anthropic prototype-patch auto-instrumentation, and
 * wires the analytics/logs stream. Every `messages.create` span then fans out to
 * both backends.
 *
 * The IntrospectionSpanProcessor forwards its own converted copy to
 * Introspection; the Langfuse processor receives the raw span — they run
 * independently, so processor order is irrelevant.
 *
 * Run with: pnpm anthropic-langfuse
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY     - Anthropic API key
 *   INTROSPECTION_TOKEN   - Introspection API token
 *   LANGFUSE_PUBLIC_KEY   - Langfuse public key
 *   LANGFUSE_SECRET_KEY   - Langfuse secret key
 */

import Anthropic from "@anthropic-ai/sdk";
import * as introspection from "@introspection-sdk/introspection-node/otel";
import { IntrospectionSpanProcessor } from "@introspection-sdk/introspection-node/otel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

function langfuseSpanProcessor(): BatchSpanProcessor {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    throw new Error("LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set");
  }
  const baseUrl = process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com";
  return new BatchSpanProcessor(
    new OTLPTraceExporter({
      url: `${baseUrl}/api/public/otel/v1/traces`,
      headers: {
        Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`,
      },
    }),
  );
}

async function main() {
  // You own the provider and its processor list — Introspection alongside
  // Langfuse. Anthropic spans are handed to both.
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "anthropic-langfuse",
    }),
    spanProcessors: [
      new IntrospectionSpanProcessor({
        token: process.env.INTROSPECTION_TOKEN,
      }),
      langfuseSpanProcessor(),
    ],
  });
  provider.register();

  // Adopt the provider, arm Anthropic auto-instrumentation, wire logs/baggage.
  await introspection.init({ tracerProvider: provider });

  // Constructed AFTER init() — auto-traced via the prototype patch.
  const client = new Anthropic();
  await introspection.conversation(async () => {
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 128,
      messages: [{ role: "user", content: "Say hello in one word." }],
    });
    for (const block of response.content) {
      if (block.type === "text") console.log(block.text);
    }
  });

  await introspection.shutdown();
  console.log("✓ Exported to Introspection + Langfuse.");
}

main().catch(console.error);
