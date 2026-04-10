/**
 * Mastra AI SDK + Braintrust + Introspection Example (BraintrustExporter)
 *
 * Demonstrates dual exporting Mastra agent traces to both:
 * - Braintrust (via @mastra/braintrust BraintrustExporter)
 * - Introspection backend (via OtelExporter)
 *
 * Requires: BRAINTRUST_API_KEY, INTROSPECTION_TOKEN, OPENAI_API_KEY
 *
 * Run with: pnpm trace-mastra
 */

import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { Observability } from "@mastra/observability";
import { BraintrustExporter } from "@mastra/braintrust";
import { IntrospectionMastraExporter } from "@introspection-sdk/introspection-node/mastra";
import { initLogger } from "braintrust";

if (!process.env.BRAINTRUST_API_KEY) {
  throw new Error("BRAINTRUST_API_KEY must be set");
}
if (!process.env.INTROSPECTION_TOKEN) {
  throw new Error("INTROSPECTION_TOKEN must be set");
}

const logger = initLogger({
  projectName: "mastra-braintrust-introspection-demo",
});

// --- Braintrust exporter ---
const braintrustExporter = new BraintrustExporter({
  braintrustLogger: logger,
});

// --- Introspection exporter ---
const introspectionExporter = new IntrospectionMastraExporter();

// --- Mastra setup with dual export ---
const mastra = new Mastra({
  agents: {
    assistant: new Agent({
      name: "Assistant",
      instructions: "You only respond in haikus.",
      model: "openai/gpt-4o-mini",
    }),
  },
  observability: new Observability({
    configs: {
      braintrust: {
        serviceName: "mastra-braintrust-introspection-demo",
        exporters: [braintrustExporter, introspectionExporter],
      },
    },
  }),
});

async function main() {
  console.log("Exporting traces to Braintrust + Introspection");

  const agent = mastra.getAgent("assistant");
  const response = await agent.generate(
    "Tell me about recursion in programming.",
  );
  console.log("Response:", response.text);
}

main();
