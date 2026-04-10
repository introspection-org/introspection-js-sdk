/**
 * OpenAI Responses API Features Example
 *
 * Demonstrates Introspection tracing with OpenAI Responses API features:
 * web search, reasoning with detailed summaries, encrypted reasoning, and
 * remote MCP tools via DeepWiki.
 *
 * Run with: pnpm openai-responses-api
 */

import { Agent, run, addTraceProcessor, webSearchTool } from "@openai/agents";
import { IntrospectionTracingProcessor } from "@introspection-sdk/introspection-node";

async function main() {
  const processor = new IntrospectionTracingProcessor({
    serviceName: "openai-responses-api-example",
  });
  addTraceProcessor(processor);

  // --- 1. Web Search Agent (gpt-4o) ---
  console.log("=== 1. Web Search Agent (gpt-4o) ===");

  const webAgent = new Agent({
    name: "Web Search Agent",
    model: "gpt-4o",
    instructions:
      "You MUST use web search. Always search the web first before answering.",
    tools: [webSearchTool()],
  });

  const r1 = await run(webAgent, "What is the latest SpaceX launch in 2026?");
  console.log(`Response: ${r1.finalOutput?.slice(0, 200)}...\n`);

  // --- 2. Reasoning with Detailed Summary (gpt-5.4) ---
  console.log("=== 2. Reasoning with Detailed Summary (gpt-5.4) ===");

  const reasoningAgent = new Agent({
    name: "Reasoning Agent",
    model: "gpt-5.4",
    instructions: "Think step by step. Show your work.",
    modelSettings: {
      reasoning: { effort: "high", summary: "detailed" },
    },
  });

  const r2 = await run(
    reasoningAgent,
    "A farmer has 17 chickens and 23 cows. Each chicken eats 0.5kg of feed per day " +
      "and each cow eats 15kg. If feed costs $0.40/kg, how much does the farmer spend per week?",
  );
  console.log(`Response: ${r2.finalOutput?.slice(0, 200)}...\n`);

  // --- 3. Encrypted Reasoning + Detailed Summary (gpt-5.4) ---
  console.log("=== 3. Encrypted Reasoning + Detailed Summary (gpt-5.4) ===");

  const encryptedAgent = new Agent({
    name: "Encrypted Reasoning Agent",
    model: "gpt-5.4",
    instructions: "Think carefully before answering.",
    modelSettings: {
      reasoning: { effort: "high", summary: "detailed" },
      providerData: { include: ["reasoning.encrypted_content"] },
    },
  });

  const r3 = await run(
    encryptedAgent,
    "If a train travels at 120 km/h for 2.5 hours, then slows to 80 km/h for 1.75 hours, " +
      "what is the total distance and average speed?",
  );
  console.log(`Response: ${r3.finalOutput?.slice(0, 200)}...\n`);

  // --- 4. MCP Tools - DeepWiki (gpt-4o) ---
  console.log("=== 4. MCP Tools - DeepWiki (gpt-4o) ===");

  const mcpAgent = new Agent({
    name: "MCP DeepWiki Agent",
    model: "gpt-4o",
    instructions:
      "Use the DeepWiki MCP tools to answer questions about code repositories.",
    modelSettings: {
      providerData: {
        tools: [
          {
            type: "mcp",
            server_label: "deepwiki",
            server_url: "https://mcp.deepwiki.com/mcp",
            require_approval: "never",
          },
        ],
      },
    },
  });

  const r4 = await run(
    mcpAgent,
    "How does the Agent class work in the openai/openai-agents-python repo?",
  );
  console.log(`Response: ${r4.finalOutput?.slice(0, 200)}...\n`);

  await processor.shutdown();
  console.log("✓ All examples completed and traces exported.");
}

main().catch(console.error);
