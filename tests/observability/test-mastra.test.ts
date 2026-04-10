import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Polly } from "@pollyjs/core";
import { createServer, type Server, type IncomingMessage } from "http";
import { setupPolly, ensureEnvVarsForReplay } from "../polly-setup";

interface OtlpAttribute {
  key: string;
  value: {
    stringValue?: string;
    intValue?: number;
    doubleValue?: number;
    boolValue?: boolean;
  };
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  name: string;
  attributes: OtlpAttribute[];
}

interface OtlpPayload {
  resourceSpans: Array<{
    scopeSpans: Array<{
      spans: OtlpSpan[];
    }>;
  }>;
}

/**
 * Start a local HTTP server that captures OTLP JSON payloads.
 */
function startCaptureServer(): Promise<{
  server: Server;
  port: number;
  getSpans: () => OtlpSpan[];
}> {
  const capturedSpans: OtlpSpan[] = [];

  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        try {
          const body = Buffer.concat(chunks).toString("utf-8");
          const payload: OtlpPayload = JSON.parse(body);

          for (const rs of payload.resourceSpans ?? []) {
            for (const ss of rs.scopeSpans ?? []) {
              for (const span of ss.spans ?? []) {
                capturedSpans.push(span);
              }
            }
          }
        } catch {
          // ignore parse errors
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });

    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        server,
        port,
        getSpans: () => capturedSpans,
      });
    });
  });
}

/**
 * Extract a flat attribute map from OTLP span attributes.
 */
function extractAttributes(
  attrs: OtlpAttribute[],
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const attr of attrs) {
    if (attr.value.stringValue !== undefined) {
      result[attr.key] = attr.value.stringValue;
    } else if (attr.value.intValue !== undefined) {
      result[attr.key] = Number(attr.value.intValue);
    } else if (attr.value.doubleValue !== undefined) {
      result[attr.key] = attr.value.doubleValue;
    } else if (attr.value.boolValue !== undefined) {
      result[attr.key] = attr.value.boolValue;
    }
  }
  return result;
}

/** Dynamic OTLP attributes to replace with placeholders. */
const DYNAMIC_KEYS: Record<string, string> = {
  "gen_ai.response.id": "<response_id>",
  "gen_ai.usage.input_tokens": "<input_tokens>",
  "gen_ai.usage.output_tokens": "<output_tokens>",
  "gen_ai.usage.reasoning_tokens": "<reasoning_tokens>",
  "gen_ai.output.messages": "<output_messages>",
  "gen_ai.response.model": "<response_model>",
  "gen_ai.response.finish_reasons": "<finish_reasons>",
  "gen_ai.provider.name": "<provider_name>",
  "mastra.metadata.runId": "<run_id>",
};

/**
 * Simplify an OTLP span for inline snapshot: keep name + normalized attributes.
 */
function simplifyOtlpSpan(span: OtlpSpan): {
  name: string;
  attributes: Record<string, string | number | boolean>;
} {
  const raw = extractAttributes(span.attributes);
  const attributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    attributes[key] = key in DYNAMIC_KEYS ? DYNAMIC_KEYS[key] : value;
  }
  return { name: span.name, attributes };
}

describe("Mastra AI SDK OTEL Tests", () => {
  let captureServer: Awaited<ReturnType<typeof startCaptureServer>> | null =
    null;
  let polly: Polly | null = null;

  beforeEach(async () => {
    try {
      await import("@mastra/core");
      await import("@mastra/observability");
      await import("@mastra/otel-exporter");
    } catch {
      console.log(
        "Skipping: Mastra packages not installed (@mastra/core, @mastra/observability, @mastra/otel-exporter)",
      );
      return;
    }

    // Only intercept fetch (OpenAI calls); let node-http through to local capture server
    polly = setupPolly({ recordingName: "mastra-otel", adapters: ["fetch"] });

    if (!ensureEnvVarsForReplay(["OPENAI_API_KEY"], "mastra-otel")) {
      console.log(
        "Skipping: Required env vars not set for record/passthrough mode",
      );
      await polly.stop();
      polly = null;
      return;
    }

    captureServer = await startCaptureServer();
  });

  afterEach(async () => {
    if (captureServer) {
      await new Promise<void>((resolve) =>
        captureServer!.server.close(() => resolve()),
      );
      captureServer = null;
    }
    if (polly) {
      await polly.stop();
      polly = null;
    }
  });

  it("should capture Mastra agent generation with gen_ai attributes", async () => {
    if (!captureServer) {
      return;
    }

    let Mastra, Agent, Observability, OtelExporter, openai;
    try {
      ({ Mastra } = await import("@mastra/core"));
      ({ Agent } = await import("@mastra/core/agent"));
      ({ Observability } = await import("@mastra/observability"));
      ({ OtelExporter } = await import("@mastra/otel-exporter"));
      ({ openai } = await import("@ai-sdk/openai"));
    } catch {
      console.log("Skipping: required Mastra/AI SDK packages not installed");
      return;
    }

    const endpoint = `http://localhost:${captureServer.port}/v1/traces`;

    const otelExporter = new OtelExporter({
      provider: {
        custom: {
          endpoint,
          protocol: "http/json",
          headers: {},
        },
      },
    });

    const observability = new Observability({
      configs: {
        otel: {
          serviceName: "mastra-test",
          exporters: [otelExporter],
        },
      },
    });

    const mastra = new Mastra({ observability });

    // Eagerly initialize the OtelExporter's OTEL pipeline (BatchSpanProcessor,
    // SpanConverter, etc.) so it's ready when spans are emitted. Without this,
    // the lazy setup() races with Mastra's fire-and-forget span.end() calls,
    // causing spans to be lost before the processor is created.
    await (otelExporter as any).setup();

    const agent = new Agent({
      id: "test-agent",
      name: "test-agent",
      instructions: "You are a helpful assistant. Reply in one sentence.",
      model: openai("gpt-5-nano"),
      mastra,
    });

    const result = await agent.generate("Say hello in one word.");

    expect(result.text).toBeDefined();
    expect(result.text.length).toBeGreaterThan(0);

    // Flush the OTEL pipeline — span.end() in Mastra is fire-and-forget,
    // so we must explicitly flush to ensure spans reach the capture server.
    await otelExporter.flush();
    // Give the HTTP server a moment to process incoming requests
    await new Promise((resolve) => setTimeout(resolve, 500));

    const spans = captureServer.getSpans();
    expect(spans.length).toBeGreaterThan(0);

    const allSimplified = spans.map(simplifyOtlpSpan);

    // Chat span — the main generation
    const chatSpan = allSimplified.find(
      (s) => s.attributes["gen_ai.operation.name"] === "chat",
    );
    expect(chatSpan).toBeDefined();
    expect(chatSpan).toMatchInlineSnapshot(
      `
      {
        "attributes": {
          "gen_ai.agent.id": "test-agent",
          "gen_ai.agent.name": "test-agent",
          "gen_ai.input.messages": "[{"role":"system","parts":[{"type":"text","content":"You are a helpful assistant. Reply in one sentence."}]},{"role":"user","parts":[{"type":"text","content":"Say hello in one word."}]}]",
          "gen_ai.operation.name": "chat",
          "gen_ai.output.messages": "<output_messages>",
          "gen_ai.provider.name": "<provider_name>",
          "gen_ai.request.model": "gpt-5-nano",
          "gen_ai.request.temperature": 0,
          "gen_ai.response.finish_reasons": "<finish_reasons>",
          "gen_ai.response.id": "<response_id>",
          "gen_ai.response.model": "<response_model>",
          "gen_ai.usage.input_tokens": "<input_tokens>",
          "gen_ai.usage.output_tokens": "<output_tokens>",
          "gen_ai.usage.reasoning_tokens": "<reasoning_tokens>",
          "mastra.metadata.runId": "<run_id>",
          "mastra.span.type": "model_generation",
        },
        "name": "chat gpt-5-nano",
      }
    `,
    );

    await observability.shutdown();
  });
});
