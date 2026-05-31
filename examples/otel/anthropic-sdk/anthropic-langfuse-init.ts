/**
 * Anthropic SDK + Langfuse dual export via `introspection.init()`.
 *
 * Demonstrates dual export: Anthropic calls are sent to both Langfuse and
 * Introspection. Instead of wiring processors and an instrumentor by hand, this
 * passes the Langfuse span processor to `init({ spanProcessors: [...] })`, which
 * composes it alongside Introspection's processor on one provider — so a single
 * set of spans fans out to both backends, and Anthropic is auto-instrumented.
 *
 * (OpenTelemetry JS v2 sets span processors at provider construction, so the
 * one-call dual-export path is `init({ spanProcessors })` rather than attaching
 * to an existing provider.)
 *
 * Run with: pnpm anthropic-langfuse-init
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY     - Anthropic API key
 *   LANGFUSE_PUBLIC_KEY   - Langfuse public key
 *   LANGFUSE_SECRET_KEY   - Langfuse secret key
 *   INTROSPECTION_TOKEN   - Introspection API token
 */

import Anthropic from "@anthropic-ai/sdk";
import * as introspection from "@introspection-sdk/introspection-node/otel";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

async function main() {
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
    throw new Error("LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set");
  }

  const langfuseAuth = Buffer.from(
    `${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`,
  ).toString("base64");
  const langfuseBaseUrl =
    process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com";

  // 1. A Langfuse span processor.
  const langfuseProcessor = new BatchSpanProcessor(
    new OTLPTraceExporter({
      url: `${langfuseBaseUrl}/api/public/otel/v1/traces`,
      headers: { Authorization: `Basic ${langfuseAuth}` },
    }),
  );

  // 2. One call: composes Langfuse + Introspection processors on one provider
  //    and patches the installed frameworks. Anthropic now exports to both.
  await introspection.init({
    serviceName: "anthropic-langfuse-init",
    spanProcessors: [langfuseProcessor],
  });

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
  console.log("✓ Exported to Langfuse + Introspection.");
}

main().catch(console.error);
