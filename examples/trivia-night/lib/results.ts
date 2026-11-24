/**
 * A run's trial results, kept on disk beside its trials: the activity feed is
 * bounded, so a long run's early results can leave it before anyone analyses
 * them. One JSON line per eval.finished or eval.run_finished record.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface ResultLine {
  type: "eval.finished" | "eval.run_finished";
  data: Record<string, unknown>;
}

export const resultsFile = (recipeDir: string, run: string) =>
  path.join(recipeDir, "eval-runs", run, "results.jsonl");

export function appendResult(file: string, line: ResultLine): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(line)}\n`);
}

export function readResults(file: string): ResultLine[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ResultLine);
}

/** A trial counts in the analysis only when it ran: one that errored measured nothing. */
export const scored = (trial: { error?: unknown } | null | undefined) =>
  Boolean(trial) && !trial?.error;
