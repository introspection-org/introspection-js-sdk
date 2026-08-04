#!/usr/bin/env node
/**
 * `introspection-capture` — the executable a host hook points at.
 *
 * Reads a hook event on stdin and exports the turn. Always exits 0: a non-zero
 * exit from a hook is a signal to the host, and "telemetry had a bad day" is not
 * something a coding session should ever be told about.
 *
 * Diagnostics go to stderr only when asked for (`--debug`), because a hook that
 * chatters into a user's terminal on every turn gets uninstalled.
 *
 *   introspection-capture --host claude-code
 *   introspection-capture --host codex --dry-run --debug
 */
import { readStdin, runHook } from "./hook.js";
import type { CaptureHost } from "./config.js";

function parseArgs(argv: string[]): {
  host?: CaptureHost;
  dryRun: boolean;
  debug: boolean;
} {
  let host: CaptureHost | undefined;
  let dryRun = false;
  let debug = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--host" || arg === "--target") {
      const value = argv[i + 1];
      if (value === "claude-code" || value === "codex") host = value;
      i += 1;
    } else if (arg === "--host=claude-code" || arg === "--target=claude-code") {
      host = "claude-code";
    } else if (arg === "--host=codex" || arg === "--target=codex") {
      host = "codex";
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--debug") {
      debug = true;
    }
  }

  return { host, dryRun, debug };
}

async function main(): Promise<void> {
  const { host, dryRun, debug } = parseArgs(process.argv.slice(2));
  const result = await runHook(await readStdin(), host, { dryRun });

  if (debug || dryRun) {
    const parts = [`outcome=${result.outcome}`];
    if (result.spanCount !== undefined) parts.push(`spans=${result.spanCount}`);
    if (result.bytesRead !== undefined) parts.push(`bytes=${result.bytesRead}`);
    if (result.detail) parts.push(`detail=${result.detail}`);
    process.stderr.write(`introspection-capture: ${parts.join(" ")}\n`);
  }
}

// The catch is the last line of the fail-open guarantee: even a bug in the
// argument parsing or an unexpected rejection must not surface to the host.
main()
  .catch(() => undefined)
  .finally(() => {
    process.exitCode = 0;
  });
