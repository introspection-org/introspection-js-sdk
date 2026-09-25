import type { Observation } from "../types.js";
import type { Decision, Driver, StepInput } from "./types.js";

/** Clicks that change state need more certainty than a scroll. */
const RISKY =
  /\b(submit|pay|buy|purchase|order|book|confirm|delete|remove|send|sign|transfer)\b/i;

export interface GatePolicy {
  minOpConfidence: number;
  minTargetConfidence: number;
  minTargetMargin: number;
  minDoneConfidence: number;
  minRiskyConfidence: number;
}

/** Starting values from the Phase 0 measurements; tune per site from graded runs. */
export const DEFAULT_GATE_POLICY: GatePolicy = {
  minOpConfidence: 0.55,
  minTargetConfidence: 0.6,
  minTargetMargin: 0.2,
  minDoneConfidence: 0.85,
  minRiskyConfidence: 0.8,
};

/** Why a decision should be re-made by the fallback, or null to accept it. */
export function reviewReason(
  decision: Decision,
  observation: Observation,
  policy: GatePolicy = DEFAULT_GATE_POLICY,
): string | null {
  if (decision.op === "blocked")
    return `fast driver blocked: ${decision.reason ?? ""}`.trim();
  const s = decision.signal;
  if (!s) return null;
  if (decision.op === "done" && s.op.confidence < policy.minDoneConfidence) {
    return `done at ${s.op.confidence}`;
  }
  if (s.op.confidence < policy.minOpConfidence)
    return `operation confidence ${s.op.confidence}`;
  if (s.target) {
    if (s.target.confidence < policy.minTargetConfidence)
      return `target confidence ${s.target.confidence}`;
    if (s.target.margin < policy.minTargetMargin) {
      return `targets ${s.target.top.map((t) => t.choice).join(" vs ")} too close (margin ${s.target.margin.toFixed(2)})`;
    }
    const el = observation.elements.find((e) => e.element === decision.element);
    const least = Math.min(s.op.confidence, s.target.confidence);
    if (el && RISKY.test(el.name) && least < policy.minRiskyConfidence) {
      return `state-changing "${el.name}" at ${least}`;
    }
  }
  return null;
}

/**
 * Per-step escalation: `fast` decides every step; a step whose signal fails
 * the policy is re-decided by `fallback`, which sees the fast driver's ranked
 * candidates as a hint. The next step goes back to `fast`.
 */
export class GatedDriver implements Driver {
  readonly name: string;
  readonly vision?: boolean;

  constructor(
    private readonly fast: Driver,
    private readonly fallback: Driver,
    private readonly policy: GatePolicy = DEFAULT_GATE_POLICY,
  ) {
    this.name = `${fast.name}?${fallback.name}`;
    this.vision = fallback.vision;
  }

  async decide(input: StepInput): Promise<Decision & { escalated?: string }> {
    let decision: Decision;
    try {
      decision = await this.fast.decide(input);
    } catch (err) {
      decision = { op: "blocked", reason: (err as Error).message };
    }
    const why = reviewReason(decision, input.observation, this.policy);
    if (!why) return decision;
    const hint =
      `A fast model proposed ${decision.op}${decision.element ? ` [${decision.element}]` : ""} ` +
      `but was unsure (${why}). Its ranked candidates: ${JSON.stringify(decision.signal ?? {})}. Decide independently.`;
    const second = await this.fallback.decide({
      ...input,
      goal: `${input.goal}\n\n(${hint})`,
    });
    return { ...second, escalated: why };
  }
}
