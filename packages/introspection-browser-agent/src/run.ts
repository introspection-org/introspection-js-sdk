import type { BrowserSession } from "./session.js";
import { renderTable } from "./table.js";
import { BrowserError, type Observation } from "./types.js";
import type { Decision, Driver, StepRecord } from "./drivers/types.js";

export interface RunOptions {
  goal: string;
  /** Cheapest first: `[jev, claude, claudeVision]`, or one `GatedDriver`. */
  drivers: Driver[];
  maxSteps?: number;
  /** Steps a rung may spend before the next one takes over. */
  stepsPerRung?: number;
  /**
   * `done` is a claim, not a verdict: when set, it must pass before `run`
   * reports success. Otherwise the step is recorded and the run continues.
   */
  success?: (observation: Observation) => boolean | Promise<boolean>;
  onStep?: (step: StepRecord, observation: Observation) => void;
  signal?: AbortSignal;
}

export type RunStatus =
  "done" | "blocked" | "failed" | "budget_exhausted" | "aborted";

export interface RunResult {
  status: RunStatus;
  result: string | null;
  reason?: string;
  url: string;
  steps: StepRecord[];
  escalations: number;
  elapsedMs: number;
}

/**
 * The driver ladder: start on the cheapest driver, move up on `blocked`, on
 * two invalid actions in a row, on three actions in a row that change nothing
 * on the page, or when a rung spends its step budget. Each rung resumes from
 * the same page and history rather than restarting.
 */
export async function runDriverLadder(
  session: BrowserSession,
  options: RunOptions,
): Promise<RunResult> {
  const started = Date.now();
  const maxSteps = options.maxSteps ?? 30;
  const stepsPerRung = options.stepsPerRung ?? 15;
  const steps: StepRecord[] = [];
  let rung = 0;
  let rungSteps = 0;
  let failures = 0;
  let escalations = 0;
  let url = "";
  // The fingerprint the last action was decided on, to tell whether it did anything.
  let decidedOn: string | undefined;

  const finish = (
    status: RunStatus,
    extra: Partial<RunResult> = {},
  ): RunResult => ({
    status,
    result: null,
    url,
    steps,
    escalations,
    elapsedMs: Date.now() - started,
    ...extra,
  });
  const escalate = (): boolean => {
    if (rung + 1 >= options.drivers.length) return false;
    rung += 1;
    rungSteps = 0;
    failures = 0;
    escalations += 1;
    return true;
  };

  for (let step = 0; step < maxSteps; step++) {
    if (options.signal?.aborted) return finish("aborted");
    const driver = options.drivers[rung]!;
    const observation = await session.observe({
      screenshot: Boolean(driver.vision),
      scope: driver.observation,
    });
    url = observation.url;

    const last = steps.at(-1);
    if (last && decidedOn !== undefined && last.page_changed === undefined) {
      last.page_changed = observation.fingerprint !== decidedOn;
      const recent = steps.slice(-3);
      if (
        recent.length === 3 &&
        recent.every((s) => s.page_changed === false && s.op !== "wait")
      ) {
        if (escalate()) continue;
        return finish("blocked", {
          reason: "three actions in a row changed nothing on the page",
        });
      }
    }
    decidedOn = undefined;

    let decision: Decision & { escalated?: string };
    try {
      decision = await driver.decide({
        goal: options.goal,
        observation,
        table: renderTable(observation),
        history: steps,
        step,
      });
    } catch (err) {
      decision = {
        op: "blocked",
        reason: `driver error: ${(err as Error).message}`,
      };
    }
    const record: StepRecord = { ...decision, driver: driver.name };
    if (decision.escalated) escalations += 1;

    if (decision.op === "done") {
      if (!options.success || (await options.success(observation))) {
        steps.push(record);
        options.onStep?.(record, observation);
        return finish("done", { result: decision.text ?? null });
      }
      record.error = "success check failed";
    } else if (decision.op === "blocked") {
      steps.push(record);
      options.onStep?.(record, observation);
      if (escalate()) continue;
      return finish("blocked", { reason: decision.reason });
    } else {
      try {
        await perform(session, decision);
        decidedOn = observation.fingerprint;
        failures = 0;
      } catch (err) {
        if (!(err instanceof BrowserError)) throw err;
        record.error = `${err.code}: ${err.message}`;
      }
    }

    if (record.error) failures += 1;
    steps.push(record);
    options.onStep?.(record, observation);
    rungSteps += 1;
    if (failures >= 2 || rungSteps >= stepsPerRung) {
      if (!escalate() && failures >= 3) {
        return finish("failed", { reason: record.error });
      }
    }
  }
  return finish("budget_exhausted");
}

async function perform(session: BrowserSession, d: Decision): Promise<void> {
  switch (d.op) {
    case "click":
      if (d.element === undefined && d.x !== undefined && d.y !== undefined) {
        await session.clickAt({ x: d.x, y: d.y });
        return;
      }
      if (!d.element)
        throw new BrowserError("invalid_argument", "click needs an element");
      await session.act({ element: d.element, action: "click" });
      return;
    case "type":
    case "select":
      if (!d.element)
        throw new BrowserError("invalid_argument", `${d.op} needs an element`);
      await session.act({
        element: d.element,
        action: d.op,
        text: d.text,
        value: d.value,
      });
      return;
    case "press":
      if (!d.keys?.length)
        throw new BrowserError("invalid_argument", "press needs keys");
      await session.press({ keys: d.keys });
      return;
    case "scroll":
      await session.scroll({ direction: d.direction ?? "down" });
      return;
    case "navigate":
      if (!d.url)
        throw new BrowserError("invalid_argument", "navigate needs a url");
      await session.navigate({ url: d.url });
      return;
    case "wait":
      await new Promise((r) => setTimeout(r, 800));
      return;
    default:
      throw new BrowserError("invalid_argument", `unknown op ${String(d.op)}`);
  }
}
