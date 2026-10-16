// Reads the code a walkthrough step points at, cut to the part that matters.
// Region markers never appear in what is shown.
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { recipe } from "../flow/recipe.mjs";

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

const fetched = new Map();

/**
 * A recipe file on the recipe's main branch. The repository is private until it is
 * published, so GITHUB_TOKEN is sent when set; without it, a link stands in.
 * @param {string} path
 */
async function recipeFile(path) {
  if (!fetched.has(path)) {
    const token = process.env.GITHUB_TOKEN;
    fetched.set(
      path,
      fetch(`${recipe.raw}/${recipe.ref}/${path}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
        .then((response) => (response.ok ? response.text() : null))
        .catch(() => null),
    );
  }
  const text = await fetched.get(path);
  return (
    text ??
    `# Not fetched: ${recipe.repository}/blob/${recipe.ref}/${path}\n# Set GITHUB_TOKEN to read the recipe here.`
  );
}

/** @param {string} root @param {import("../flow/manifest.mjs").Source} source */
export async function readSource(root, source) {
  const text =
    source.kind === "recipe"
      ? await recipeFile(source.path)
      : readFileSync(
          join(
            source.kind === "example" ? root : join(root, "flow/contracts"),
            source.path,
          ),
          "utf8",
        );
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
        ? posix.normalize(`examples/aauth-travel/${source.path}`)
        : source.kind === "recipe"
          ? `recipe-travel-agent/${source.path}`
          : `platform contract: ${source.path}`,
  };
}
