import {
  DECISION_OPS,
  SYSTEM_PROMPT,
  historyText,
  type Decision,
  type Driver,
  type StepInput,
} from "./types.js";

export interface OpenAICompatibleDriverOptions {
  model: string;
  /** Any `/chat/completions` server: OpenAI, OpenRouter, vLLM, a gateway. */
  baseUrl?: string;
  apiKey?: string;
  fetch?: typeof fetch;
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
    const res = await doFetch(`${this.baseUrl}/chat/completions`, {
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
              `"element"?: string, "text"?: string, "url"?: string, "direction"?: "up"|"down", "reason": string}.`,
          },
          {
            role: "user",
            content: `GOAL: ${input.goal}\n\nRECENT ACTIONS:\n${historyText(input.history)}\n\n${input.table}`,
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`model returned HTTP ${res.status}`);
    const body = (await res.json()) as {
      choices: { message: { content: string } }[];
      usage?: unknown;
    };
    const decision = JSON.parse(
      body.choices[0]?.message.content ?? "{}",
    ) as Decision;
    return { ...decision, usage: body.usage, latencyMs: Date.now() - started };
  }
}
