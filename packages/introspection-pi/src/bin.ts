#!/usr/bin/env node
/**
 * `pi-session-spans <file> [conversation-id]`: print a Pi session file as a
 * GenAI span list on stdout.
 *
 * An eval adapter execs this inside a trial after a Pi run, so the trial's
 * trajectory is projected from the same spans the platform stores.
 */
import { readFileSync } from "node:fs";

import { piSessionToSpans } from "./session-spans.js";

const [path, conversationId = "pi-session"] = process.argv.slice(2);
if (!path) {
  process.stderr.write("usage: pi-session-spans <file> [conversation-id]\n");
  // Not process.exit(): it drops whatever a piped stdout has not flushed yet,
  // which truncates any span list over the pipe buffer.
  process.exitCode = 2;
} else {
  const spans = piSessionToSpans(readFileSync(path, "utf8"), conversationId);
  process.stdout.write(`${JSON.stringify(spans)}\n`);
}
