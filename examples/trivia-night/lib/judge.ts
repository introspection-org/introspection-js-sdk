/**
 * The return-visit judge over one finished night 2: its trajectory.json as the
 * normalized conversation `introspection judges run --conversation` reads, the
 * command that grades it, and the score read back from its results.jsonl.
 * Run locally only: the page itself does not judge, since it spawns nothing.
 */
/** A command line and its options, for `node:child_process` spawn. */
export interface SpawnSpec {
  command: string;
  args: string[];
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    shell: false;
    stdio: ["ignore", "pipe", "pipe"];
  };
}

export const JUDGE_FILE = "judges/return-visit.yaml";
export const JUDGE_NAME = "return-visit";

interface AtifStep {
  source?: string;
  message?: unknown;
  tool_calls?: {
    tool_call_id: string;
    function_name: string;
    arguments?: unknown;
  }[];
  observation?: { results?: { source_call_id?: string; content?: unknown }[] };
}

type JudgeEvent =
  | { type: "message"; role: "user" | "assistant"; content: string }
  | { type: "tool_call"; id: string; name: string; arguments: unknown }
  | { type: "tool_result"; tool_call_id: string; content: unknown };

/** One line of the judge's input: a trajectory.json's steps as normalized events, without the system prompt. */
export function judgeInput(
  customId: string,
  trajectory: { steps?: AtifStep[] },
): { custom_id: string; trajectory: JudgeEvent[] } {
  const events: JudgeEvent[] = [];
  for (const step of trajectory.steps ?? []) {
    const text = typeof step.message === "string" ? step.message.trim() : "";
    if (step.source === "user" && text)
      events.push({ type: "message", role: "user", content: text });
    if (step.source !== "agent") continue;
    if (text)
      events.push({ type: "message", role: "assistant", content: text });
    for (const call of step.tool_calls ?? [])
      events.push({
        type: "tool_call",
        id: call.tool_call_id,
        name: call.function_name,
        arguments: call.arguments ?? {},
      });
    for (const result of step.observation?.results ?? [])
      if (result.source_call_id)
        events.push({
          type: "tool_result",
          tool_call_id: result.source_call_id,
          content: result.content ?? "",
        });
  }
  return { custom_id: customId, trajectory: events };
}

/** `introspection judges run` over one input file; a provider key reaches it only through the environment. */
export function judgeSpec(
  inputFile: string,
  outDir: string,
  recipeDir: string,
  baseEnv: Record<string, string | undefined> = process.env,
): SpawnSpec {
  return {
    command: "introspection",
    args: [
      "judges",
      "run",
      "--conversation",
      inputFile,
      "--judge",
      JUDGE_FILE,
      "--recipe-root",
      recipeDir,
      "--out",
      outDir,
      "-o",
      "json",
      "--non-interactive",
    ],
    options: {
      cwd: recipeDir,
      env: { ...baseEnv },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  };
}

export interface Judgement {
  /** 1-5, or null when the judge gave none. */
  score: number | null;
  /** Its one-line reason, without the score. */
  reason: string | null;
  error: string | null;
}

/** The return-visit judgement for one conversation from a results.jsonl; null when it has none. */
export function parseJudgement(
  results: string,
  customId: string,
): Judgement | null {
  for (const line of results.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as {
      custom_id?: string;
      judge?: string;
      result?: string;
      reasoning?: string;
      error?: string;
    };
    if (row.custom_id !== customId || row.judge !== JUDGE_NAME) continue;
    if (row.result === "error")
      return { score: null, reason: null, error: row.error ?? "judge error" };
    const match = /^\s*([1-5])\s*\/\s*5\s*[:.\-–—]?\s*/.exec(
      row.reasoning ?? "",
    );
    return {
      score: match ? Number(match[1]) : null,
      reason:
        (match
          ? (row.reasoning ?? "").slice(match[0].length)
          : (row.reasoning ?? "")
        ).trim() || null,
      error: match ? null : "the judge gave no score",
    };
  }
  return null;
}
