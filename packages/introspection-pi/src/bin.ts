#!/usr/bin/env node
/**
 * `pi-session-spans <file> [conversation-id] [--mcp-tools <json-file>]`: print
 * a Pi session file as a GenAI span list on stdout.
 *
 * An eval adapter execs this inside a trial after a Pi run, so the trial's
 * trajectory is projected from the same spans the platform stores.
 * `--mcp-tools` names a JSON object of MCP origins keyed by Pi tool name
 * (`{"<pi tool>": {"serverId", "toolName", "binding"}}`), stamped on those
 * tools' `execute_tool` spans.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { mcpToolLookupFromJson, piSessionToSpans } from "./session-spans.js";

const USAGE =
  "usage: pi-session-spans <file> [conversation-id] [--mcp-tools <json-file>]\n";

function parse() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: { "mcp-tools": { type: "string" } },
    });
  } catch {
    return undefined;
  }
}

const args = parse();

const [path, conversationId = "pi-session"] = args?.positionals ?? [];
if (!args || !path) {
  process.stderr.write(USAGE);
  // Not process.exit(): it drops whatever a piped stdout has not flushed yet,
  // which truncates any span list over the pipe buffer.
  process.exitCode = 2;
} else {
  try {
    const mcpTools = args.values["mcp-tools"];
    const spans = piSessionToSpans(readFileSync(path, "utf8"), conversationId, {
      ...(mcpTools
        ? { mcpTool: mcpToolLookupFromJson(readFileSync(mcpTools, "utf8")) }
        : {}),
    });
    process.stdout.write(`${JSON.stringify(spans)}\n`);
  } catch (error) {
    // A caller keeps the output of a run that exits 0, so a file that cannot
    // be rendered must not look like a conversation without model calls.
    process.stderr.write(`pi-session-spans: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
