import { initializeOtel, shutdownOtel } from "./otel.js";
import {
  handleBeforeAgentStart,
  handleLlmInput,
  handleLlmOutput,
  handleBeforeToolCall,
  handleToolResultPersist,
  handleAgentEnd,
} from "./hooks.js";
import type { CaptureConfig } from "./hooks.js";

interface PluginApi {
  pluginConfig: Record<string, unknown>;
  logger: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
  on(hook: string, handler: (event: unknown, ctx: unknown) => void): void;
  registerService(svc: {
    id: string;
    start: () => void;
    stop: () => Promise<void>;
  }): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export default function register(api: PluginApi): void {
  const cfg = api.pluginConfig;
  const token = (cfg.token as string) || process.env.INTROSPECTION_TOKEN || "";
  const baseUrl =
    (cfg.baseUrl as string) ||
    process.env.INTROSPECTION_BASE_URL ||
    "https://otel.introspection.dev";
  const serviceName =
    (cfg.serviceName as string) ||
    process.env.INTROSPECTION_SERVICE_NAME ||
    "openclaw-agent";

  if (!token) {
    api.logger.error(
      "Introspection plugin disabled: no token. " +
        "Set INTROSPECTION_TOKEN env var or plugins.entries.introspection-openclaw.config.token",
    );
    return;
  }

  try {
    initializeOtel({ token, baseUrl, serviceName });
  } catch (err) {
    api.logger.error(`Introspection plugin init failed: ${err}`);
    return;
  }

  const capture: CaptureConfig = {
    captureMessageContent: cfg.captureMessageContent !== false,
    captureToolInput: cfg.captureToolInput !== false,
    captureToolOutput: cfg.captureToolOutput !== false,
    maxCaptureLength:
      typeof cfg.maxCaptureLength === "number" ? cfg.maxCaptureLength : 2048,
  };

  api.on("before_agent_start", (event, ctx) => {
    if (!isRecord(event) || !isRecord(ctx)) return;
    try {
      handleBeforeAgentStart(event, ctx);
    } catch (err) {
      api.logger.warn(`Introspection before_agent_start error: ${err}`);
    }
  });

  api.on("llm_input", (event, ctx) => {
    if (!isRecord(event) || !isRecord(ctx)) return;
    try {
      handleLlmInput(event, ctx, capture);
    } catch (err) {
      api.logger.warn(`Introspection llm_input error: ${err}`);
    }
  });

  api.on("llm_output", (event, ctx) => {
    if (!isRecord(event) || !isRecord(ctx)) return;
    try {
      handleLlmOutput(event, ctx, capture);
    } catch (err) {
      api.logger.warn(`Introspection llm_output error: ${err}`);
    }
  });

  api.on("before_tool_call", (event, ctx) => {
    if (!isRecord(event) || !isRecord(ctx)) return;
    try {
      handleBeforeToolCall(event, ctx, capture);
    } catch (err) {
      api.logger.warn(`Introspection before_tool_call error: ${err}`);
    }
  });

  api.on("tool_result_persist", (event, ctx) => {
    if (!isRecord(event) || !isRecord(ctx)) return;
    try {
      handleToolResultPersist(event, ctx, capture);
    } catch (err) {
      api.logger.warn(`Introspection tool_result_persist error: ${err}`);
    }
  });

  api.on("agent_end", (event, ctx) => {
    if (!isRecord(event) || !isRecord(ctx)) return;
    try {
      handleAgentEnd(event, ctx);
    } catch (err) {
      api.logger.warn(`Introspection agent_end error: ${err}`);
    }
  });

  api.registerService({
    id: "introspection-otel",
    start: () => {
      api.logger.info(
        `Introspection: exporting to ${baseUrl} (service: ${serviceName})`,
      );
    },
    stop: async () => {
      await shutdownOtel();
      api.logger.info("Introspection: OTEL shut down");
    },
  });
}
