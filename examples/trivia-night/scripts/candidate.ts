/**
 * Make a candidate Recipe from the baseline with one memory block:
 *   pnpm -s candidate <name> <block.md>   ->  .introspection-work/cand-<name>/
 */
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [name, block] = process.argv.slice(2);
const base = ".introspection-work/trivia-host";
const out = `.introspection-work/cand-${name}`;
rmSync(out, { recursive: true, force: true });
cpSync(base, out, {
  recursive: true,
  filter: (path) => !path.includes("/.git"),
});
const system = join(out, "SYSTEM.md");
const text = readFileSync(system, "utf8");
const marked = /(<!-- memory:start -->\n)[\s\S]*?(<!-- memory:end -->)/;
if (!marked.test(text)) throw new Error("the baseline has no memory markers");
writeFileSync(
  system,
  text.replace(
    marked,
    (_, start, end) => `${start}${readFileSync(block, "utf8")}${end}`,
  ),
);
console.log(out);
