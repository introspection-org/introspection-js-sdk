// Vendors the public parts of the travel-agent recipe the walkthrough shows,
// so the demo runs offline. Run from a recipe checkout:
//   RECIPE_DIR=../../../recipe-travel-agent node scripts/sync-recipe.mjs
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const target = resolve(here, "../recipe");
const source = resolve(
  process.env.RECIPE_DIR ?? join(here, "../../../../recipe-travel-agent"),
);

const FILES = [
  "SYSTEM.md",
  "package.json",
  "agents/agent.yaml",
  "extensions/booking.js",
  "policies/schema.cedarschema",
  "policies/travel.cedar",
  "policies/routes.yaml",
];

rmSync(target, { recursive: true, force: true });
for (const file of FILES) {
  mkdirSync(dirname(join(target, file)), { recursive: true });
  cpSync(join(source, file), join(target, file));
}
const commit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
writeFileSync(
  join(target, "SOURCE.json"),
  JSON.stringify(
    {
      repository: "https://github.com/introspection-org/recipe-travel-agent",
      commit,
      files: FILES,
    },
    null,
    2,
  ) + "\n",
);
console.log(`vendored ${FILES.length} recipe files at ${commit.slice(0, 12)}`);
