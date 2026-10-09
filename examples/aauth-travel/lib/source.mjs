// Reads the code a walkthrough step points at, cut to the part that matters.
// Region markers never appear in what is shown.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REGION_MARKER = /^\s*(\/\/|#)\s*#(end)?region\b.*$/;
const LANGUAGES = {
  ts: "ts",
  tsx: "tsx",
  js: "js",
  mjs: "js",
  json: "json",
  yaml: "yaml",
  md: "markdown",
  cedar: "text",
  cedarschema: "text",
};

/** @param {string} root @param {import("../flow/manifest.mjs").Source} source */
export function readSource(root, source) {
  const base =
    source.kind === "example"
      ? root
      : join(root, source.kind === "recipe" ? "recipe" : "flow/contracts");
  const text = readFileSync(join(base, source.path), "utf8");
  let lines = text.split("\n");

  if (source.kind === "example" && source.region) {
    const start = lines.findIndex((line) =>
      new RegExp(`#region\\s+${source.region}\\b`).test(line),
    );
    const end = lines.findIndex(
      (line, i) => i > start && /#endregion\b/.test(line),
    );
    if (start < 0 || end < 0)
      throw new Error(`${source.path}: no region "${source.region}"`);
    lines = lines.slice(start + 1, end);
  }
  lines = lines.filter((line) => !REGION_MARKER.test(line));
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();

  const extension = source.path.split(".").pop() ?? "";
  return {
    code: lines.join("\n"),
    language: LANGUAGES[extension] ?? "text",
    origin:
      source.kind === "example"
        ? `examples/aauth-travel/${source.path}`
        : source.kind === "recipe"
          ? `recipe-travel-agent/${source.path}`
          : `platform contract: ${source.path}`,
  };
}
