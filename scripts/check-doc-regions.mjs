#!/usr/bin/env node
/**
 * Check the docs snippet regions in tracked files.
 *
 * The docs repo extracts code between `// #region docs:<id>` and
 * `// #endregion docs:<id>` at a pinned release tag. This fails when a
 * marker is malformed, a region is unclosed, closed with another id, or
 * nested in another, or an id appears more than once in the repo.
 *
 * Run with: pnpm check:doc-regions
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ID = /^[a-z0-9-]+(\/[a-z0-9-]+)+$/;
const MARKER = /^\/\/ #(region|endregion) docs:(\S+)$/;
// Anything that looks like it was meant to be a docs region marker.
const LOOSE = /#\s*(end)?\s*region\b.*\bdocs?\b/i;
const EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((f) => EXTENSIONS.test(f) && f !== "scripts/check-doc-regions.mjs");

const errors = [];
/** id -> "file:line" of its region */
const seen = new Map();

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // deleted in the working tree
  }
  /** @type {{ id: string, line: number } | null} */
  let open = null;
  text.split("\n").forEach((raw, i) => {
    const line = i + 1;
    const where = `${file}:${line}`;
    const trimmed = raw.replace(/\r$/, "");
    if (!LOOSE.test(trimmed)) return;
    const m = MARKER.exec(trimmed);
    if (!m) {
      errors.push(
        `${where}: malformed marker (want "// #region docs:<id>" or "// #endregion docs:<id>" at column 0): ${trimmed.trim()}`,
      );
      return;
    }
    const [, kind, id] = m;
    if (!ID.test(id)) {
      errors.push(`${where}: invalid id "${id}" (want ${ID})`);
      return;
    }
    if (kind === "region") {
      if (open) {
        errors.push(
          `${where}: region "${id}" opens inside region "${open.id}" (line ${open.line})`,
        );
      }
      if (seen.has(id)) {
        errors.push(`${where}: duplicate id "${id}" (first at ${seen.get(id)})`);
      } else {
        seen.set(id, where);
      }
      open = { id, line };
    } else if (!open) {
      errors.push(`${where}: endregion "${id}" has no open region`);
    } else if (open.id !== id) {
      errors.push(
        `${where}: endregion "${id}" closes region "${open.id}" (line ${open.line})`,
      );
      open = null;
    } else {
      open = null;
    }
  });
  if (open) {
    errors.push(`${file}:${open.line}: region "${open.id}" is never closed`);
  }
}

if (errors.length) {
  for (const e of errors) console.error(e);
  console.error(`\n${errors.length} doc region error(s)`);
  process.exit(1);
}
console.log(`${seen.size} doc region(s) OK`);
