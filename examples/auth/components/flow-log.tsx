"use client";

import type { LogLine } from "@/lib/intro";

/**
 * The shared step-by-step flow log card every mode page renders — the same
 * LogLine pattern the original single-page sample used.
 */
export function FlowLog({ log }: { log: LogLine[] }) {
  if (log.length === 0) return null;
  return (
    <div className="card">
      <div className="step">Flow</div>
      <div className="log">
        {log.map((line, i) => (
          <p
            key={i}
            className={`log-line ${
              line.kind === "ok"
                ? "log-ok"
                : line.kind === "err"
                  ? "log-err"
                  : "log-muted"
            }`}
          >
            {line.text}
          </p>
        ))}
      </div>
    </div>
  );
}
