import type { ElementRow } from "../types.js";
import {
  DECISION_OPS,
  SYSTEM_PROMPT,
  historyText,
  type Decision,
  type Driver,
  type StepInput,
} from "./types.js";

/**
 * The slice of `@anthropic-ai/sdk`'s client this driver uses. Pass a real
 * `new Anthropic()`; the package takes no dependency on the SDK so a caller
 * that never uses Claude installs nothing for it.
 */
export interface AnthropicClientLike {
  messages: {
    create(params: Record<string, unknown>): Promise<AnthropicMessage>;
  };
  beta: {
    messages: {
      create(params: Record<string, unknown>): Promise<AnthropicMessage>;
    };
  };
}

interface AnthropicMessage {
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; name: string; input: unknown }
    | { type: string }
  >;
  stop_reason: string | null;
  stop_details?: { category?: string | null } | null;
  usage?: unknown;
}

export interface ClaudeDriverOptions {
  client: AnthropicClientLike;
  /** Default `claude-opus-5`. */
  model?: string;
  /** Default `low`: one browser step rarely needs deep deliberation. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Send a screenshot with each step. */
  vision?: boolean;
  /** Server-side refusal fallbacks (`fallbacks: "default"`). Default true. */
  refusalFallbacks?: boolean;
}

const TOOL = {
  name: "browser_action",
  description: "Perform exactly one browser action on the current page.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["op", "reason"],
    properties: {
      op: { type: "string", enum: [...DECISION_OPS] },
      element: {
        type: "string",
        description: "Element handle from the table (click, type, select).",
      },
      text: {
        type: "string",
        description:
          "Text to type, option label to select, or the answer for done.",
      },
      url: { type: "string", description: "Absolute URL for navigate." },
      direction: {
        type: "string",
        enum: ["up", "down"],
        description: "For scroll.",
      },
      reason: { type: "string", description: "One short sentence." },
    },
  },
};

export class ClaudeDriver implements Driver {
  readonly name: string;
  readonly vision: boolean;
  private readonly model: string;

  constructor(private readonly options: ClaudeDriverOptions) {
    this.model = options.model ?? "claude-opus-5";
    this.vision = options.vision ?? false;
    this.name = `claude${this.vision ? "-vision" : ""}:${this.model}`;
  }

  async decide(input: StepInput): Promise<Decision> {
    const content: Record<string, unknown>[] = [];
    if (this.vision && input.observation.screenshot) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: input.observation.screenshot,
        },
      });
    }
    content.push({
      type: "text",
      text: `GOAL: ${input.goal}\n\nRECENT ACTIONS:\n${historyText(input.history)}\n\n${input.table}`,
    });
    const started = Date.now();
    const response = await this.create({
      model: this.model,
      max_tokens: 4096,
      output_config: { effort: this.options.effort ?? "low" },
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [TOOL],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content }],
    });
    const latencyMs = Date.now() - started;
    if (response.stop_reason === "refusal") {
      return {
        op: "blocked",
        reason: `model refused (${response.stop_details?.category ?? "unspecified"})`,
        usage: response.usage,
        latencyMs,
      };
    }
    const call = response.content.find(
      (b): b is { type: "tool_use"; name: string; input: unknown } =>
        b.type === "tool_use" && (b as { name?: string }).name === TOOL.name,
    );
    if (!call) {
      const said = response.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join(" ");
      return {
        op: "blocked",
        reason: `no action chosen: ${said.slice(0, 200)}`,
        usage: response.usage,
        latencyMs,
      };
    }
    return { ...(call.input as Decision), usage: response.usage, latencyMs };
  }

  async writeText(field: ElementRow, input: StepInput): Promise<string> {
    const response = await this.create({
      model: this.model,
      max_tokens: 1024,
      output_config: { effort: "low" },
      system:
        "Return only the exact text to enter in the field, inferred from the goal. " +
        "Never invent personal information. If the goal does not specify it, return an empty string.",
      messages: [
        {
          role: "user",
          content:
            `GOAL: ${input.goal}\nFIELD: ${field.role} "${field.name}" (current "${field.value ?? ""}")\n` +
            `RECENT ACTIONS:\n${historyText(input.history)}`,
        },
      ],
    });
    return response.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }

  private create(params: Record<string, unknown>): Promise<AnthropicMessage> {
    if (this.options.refusalFallbacks === false) {
      return this.options.client.messages.create(params);
    }
    return this.options.client.beta.messages.create({
      ...params,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
  }
}
