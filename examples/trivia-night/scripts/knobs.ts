/**
 * Build a memory block from one value per knob, and a candidate Recipe from it.
 *   node --import tsx scripts/knobs.ts '<config json>'   -> prints the candidate name
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const F = JSON.parse(readFileSync("improve/knobs/fragments.json", "utf8"));
const config = JSON.parse(process.argv[2]) as Record<string, string>;
const layout = F.layout[config.layout];
const block = [
  "## Memory",
  "",
  layout.load,
  F.kept[config.kept],
  F.scope[config.scope ?? "liked"],
  F.within[config.within],
  F.update[config.update],
  F.stock?.[config.stock ?? "none"] ?? "",
  layout.save,
  F.common,
  "",
]
  .filter((part, index) => index < 2 || part !== "")
  .join("\n");
const name = [
  "k",
  config.layout,
  config.kept,
  config.update,
  config.within,
  ...(config.scope && config.scope !== "liked" ? [config.scope] : []),
  ...(config.stock && config.stock !== "none" ? [config.stock] : []),
].join("-");
mkdirSync("improve/knobs/blocks", { recursive: true });
const file = `improve/knobs/blocks/${name}.md`;
writeFileSync(file, `${block}\n`);
execFileSync("node", ["--import", "tsx", "scripts/candidate.ts", name, file]);
console.log(name);
