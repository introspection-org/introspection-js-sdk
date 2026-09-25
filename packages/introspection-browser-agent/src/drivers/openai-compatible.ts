import { traceModelCall, type DriverTelemetry } from "../telemetry.js";
import {
  DECISION_OPS,
  SYSTEM_PROMPT,
  historyText,
  type Decision,
  type Driver,
  type StepInput,
} from "./types.js";

interface ChatCompletion {
  id?: string;
  model?: string;
  choices: { message: { content: string } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number | null };
  };
}

export interface OpenAICompatibleDriverOptions {
  model: string;
  /** Any `/chat/completions` server: OpenAI, OpenRouter, vLLM, a gateway. */
  baseUrl?: string;
  apiKey?: string;
  fetch?: typeof fetch;
  /** `gen_ai.provider.name` on its spans. Default `openai`. */
  provider?: string;
  /** Each request is a `chat` span with its usage; `false` disables. */
  telemetry?: DriverTelemetry | false;
}

/** GPT, open models, or anything speaking `/chat/completions` with JSON output. */
export class OpenAICompatibleDriver implements Driver {
  readonly name: string;
  private readonly baseUrl: string;

  constructor(private readonly options: OpenAICompatibleDriverOptions) {
    this.name = `openai:${options.model}`;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(
      /\/$/,
      "",
    );
  }

  async decide(input: StepInput): Promise<Decision> {
    const started = Date.now();
    const doFetch = this.options.fetch ?? fetch;
    const url = `${this.baseUrl}/chat/completions`;
    const call = {
      operation: "chat",
      provider: this.options.provider ?? "openai",
      model: this.options.model,
      url,
    };
    const body = await traceModelCall(
      this.options.telemetry,
      call,
      async () => {
        const res = await doFetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.options.apiKey
              ? { authorization: `Bearer ${this.options.apiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: this.options.model,
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content:
                  `${SYSTEM_PROMPT}\nRespond with a JSON object {"op": one of ${DECISION_OPS.join("|")}, ` +
                  `"element"?: string, "text"?: string, "url"?: string, "direction"?: "up"|"down", ` +
                  `"keys"?: string[], "reason": string}.`,
              },
              {
                role: "user",
                content: `GOAL: ${input.goal}\n\nRECENT ACTIONS:\n${historyText(input.history)}\n\n${input.table}`,
              },
            ],
          }),
        });
        if (!res.ok) throw new Error(`model returned HTTP ${res.status}`);
        const body = (await res.json()) as ChatCompletion;
        // prompt_tokens already counts the cached ones, unlike Anthropic's input.
        const cached = body.usage?.prompt_tokens_details?.cached_tokens ?? 0;
        const prompt = body.usage?.prompt_tokens;
        return {
          value: body,
          usage: {
            inputTokens: prompt === undefined ? undefined : prompt - cached,
            outputTokens: body.usage?.completion_tokens,
            cacheReadInputTokens: cached || undefined,
            responseModel: body.model,
            responseId: body.id,
          },
        };
      },
    );
    const decision = JSON.parse(
      body.choices[0]?.message.content ?? "{}",
    ) as Decision;
    return { ...decision, usage: body.usage, latencyMs: Date.now() - started };
  }
}
