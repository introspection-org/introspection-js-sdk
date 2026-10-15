/**
 * MCP origin on `execute_tool` spans — real Agent and session, real Anthropic
 * tool_use response, Polly cassette.
 *
 * A host attaches `instrumentSession` with an `mcpTool` lookup naming the MCP
 * server behind each tool it registered. Only pi's real tool loop proves the
 * lookup is consulted for the tool the model actually called, that an
 * identity the server answers during the call (its `initialize` response)
 * reaches the span, and that a built-in tool in the same run stays clean.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import type { Polly } from "@pollyjs/core";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import {
  instrumentSession,
  McpAttr,
  type McpToolOrigin,
} from "@introspection-sdk/introspection-pi";
import {
  setupPolly,
  ensureEnvVarsForReplay,
  installTestOTelGlobals,
} from "../polly-setup";
import {
  makeAgent,
  makeWeatherTool,
  piTracing,
  type PiTracing,
  type WeatherTool,
} from "./pi-fixtures";

const RECORDING = "pi-mcp";
const MCP_TOOL = "mcp_cities_lookup-timezone_0123456789";
const SYSTEM_PROMPT =
  "Always call both get_weather and the timezone lookup tool, once each, before answering. Answer in one short sentence.";
const PROMPT = "What is the weather and the timezone in Tokyo?";

interface McpServer {
  tool: AgentTool;
  /** The host's lookup, as `instrumentSession` receives it. */
  lookup: (toolName: string) => McpToolOrigin | undefined;
  /** What the lookup returned for the MCP tool, in call order. */
  seen: (McpToolOrigin | undefined)[];
  /** Cities the model asked about. */
  calls: string[];
}

/**
 * A tool the host registered from an MCP server. The server's identity is
 * unknown until it answers `initialize`, which happens inside the first call.
 */
async function makeMcpServer(): Promise<McpServer> {
  const { Type } = await import("@earendil-works/pi-ai");
  const origin: McpToolOrigin = {
    serverId: "cities",
    toolName: "lookup-timezone",
    binding: "recipe",
  };
  const seen: (McpToolOrigin | undefined)[] = [];
  const calls: string[] = [];
  const tool: AgentTool = {
    name: MCP_TOOL,
    label: "Lookup timezone",
    description: "Look up the IANA timezone of a city.",
    parameters: Type.Object({ city: Type.String() }),
    execute: async (_id, params) => {
      const city = (params as { city: string }).city;
      calls.push(city);
      origin.serverName = "cities-mcp";
      origin.serverVersion = "1.2.0";
      const result = city === "Tokyo" ? "Asia/Tokyo" : `No data for ${city}`;
      return { content: [{ type: "text", text: result }], details: { result } };
    },
  };
  const lookup = (toolName: string) => {
    if (toolName !== MCP_TOOL) return undefined;
    seen.push({ ...origin });
    return origin;
  };
  return { tool, lookup, seen, calls };
}

describe("Pi MCP tool spans — real Agent against a Polly-recorded Anthropic call", () => {
  let polly: Polly | null = null;
  let tracing: PiTracing | null = null;
  let disposeOTel: (() => void) | null = null;

  beforeAll(async () => {
    polly = setupPolly({ recordingName: RECORDING });
    if (!ensureEnvVarsForReplay(["ANTHROPIC_API_KEY"], RECORDING)) {
      await polly.stop();
      polly = null;
    }
  });

  afterAll(async () => {
    await polly?.stop();
    polly = null;
  });

  beforeEach(() => {
    if (!polly) return;
    disposeOTel = installTestOTelGlobals();
    tracing = piTracing();
  });

  afterEach(async () => {
    if (tracing) {
      await tracing.provider.forceFlush();
      await tracing.provider.shutdown();
      tracing = null;
    }
    disposeOTel?.();
    disposeOTel = null;
  });

  it("records the MCP origin on the MCP tool's span and none on the built-in tool's", async () => {
    if (!polly) return;
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const weather: WeatherTool = await makeWeatherTool();
    const mcp = await makeMcpServer();
    const agent = await makeAgent({
      systemPrompt: SYSTEM_PROMPT,
      tools: [weather.tool, mcp.tool],
    });

    const handle = instrumentSession(
      { agent, sessionManager: SessionManager.inMemory() },
      {
        tracer: tracing!.provider.getTracer("pi-mcp-test"),
        meta: {
          conversationId: "pi-mcp-conv",
          agentId: "pi-mcp-agent",
          agentName: "Travel",
        },
        mcpTool: mcp.lookup,
      },
    );
    await agent.prompt(PROMPT);
    handle.detach();
    await tracing!.provider.forceFlush();

    // Both tools really ran from pi's loop.
    expect(weather.calls).toEqual(["Tokyo"]);
    expect(mcp.calls).toEqual(["Tokyo"]);

    // The server's identity was unknown when the span started and learned
    // during the call.
    expect(mcp.seen).toHaveLength(2);
    expect(mcp.seen[0]?.serverName).toBeUndefined();
    expect(mcp.seen[0]?.serverVersion).toBeUndefined();
    expect(mcp.seen[1]?.serverName).toBe("cities-mcp");

    const tools = tracing!.spansFor("execute_tool");
    expect(tools).toHaveLength(2);

    const mcpSpan = tools.find((s) => s.name === `execute_tool ${MCP_TOOL}`);
    expect(mcpSpan?.attributes).toMatchObject({
      [McpAttr.SERVER_ID]: "cities",
      [McpAttr.TOOL_NAME]: "lookup-timezone",
      [McpAttr.SERVER_BINDING]: "recipe",
      [McpAttr.SERVER_NAME]: "cities-mcp",
      [McpAttr.SERVER_VERSION]: "1.2.0",
    });

    const builtInSpan = tools.find(
      (s) => s.name === "execute_tool get_weather",
    );
    expect(builtInSpan).toBeDefined();
    expect(
      Object.keys(builtInSpan!.attributes).filter((key) =>
        key.startsWith("mcp."),
      ),
    ).toEqual([]);
  });
});
