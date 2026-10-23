/**
 * Print the walk's SDK coverage as a terminal table: the resource clients
 * per package, worst first, from the json-summary `test:walk:cov` writes.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Table from "cli-table3";
import pc from "picocolors";

type Metric = { total: number; covered: number; pct: number };
type Entry = Record<"lines" | "statements" | "functions" | "branches", Metric>;

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const summaryFile = path.join(repoRoot, "coverage/walk/coverage-summary.json");
const summary = JSON.parse(fs.readFileSync(summaryFile, "utf8")) as Record<
  string,
  Entry
>;
const PACKAGES = ["introspection-http", "introspection-node"];

const colour = (pct: number) =>
  pct >= 80 ? pc.green : pct >= 50 ? pc.yellow : pc.red;
const bar = (pct: number, width = 20) => {
  const full = Math.round((pct / 100) * width);
  return colour(pct)("█".repeat(full)) + pc.dim("░".repeat(width - full));
};
const row = (name: string, e: Entry) => [
  name,
  bar(e.lines.pct),
  colour(e.lines.pct)(`${e.lines.pct.toFixed(1)}%`),
  pc.dim(`${e.lines.covered}/${e.lines.total}`),
  `${e.functions.pct.toFixed(0)}%`,
];

const totals: Record<string, Metric> = {};
for (const pkg of PACKAGES) {
  const files = Object.entries(summary)
    .filter(([file]) => file.includes(`/packages/${pkg}/src/resources/`))
    .filter(([, e]) => e.lines.total > 0)
    .sort(([, a], [, b]) => a.lines.pct - b.lines.pct);
  const table = new Table({
    head: [pkg, "lines", "%", "covered", "funcs"].map((h) => pc.bold(h)),
    colAligns: ["left", "left", "right", "right", "right"],
    colWidths: [20, 22, 8, 9, 7],
    style: { head: [], border: [] },
    chars: { mid: "", "left-mid": "", "mid-mid": "", "right-mid": "" },
  });
  for (const [file, e] of files) {
    table.push(row(path.basename(file, ".ts"), e));
    const t = (totals.lines ??= { total: 0, covered: 0, pct: 0 });
    t.total += e.lines.total;
    t.covered += e.lines.covered;
  }
  console.log(table.toString());
}
const resources = totals.lines;
const all = summary.total;
console.log(
  `${pc.bold("resources")} ${colour(
    (100 * resources.covered) / resources.total,
  )(
    `${((100 * resources.covered) / resources.total).toFixed(1)}%`,
  )} of ${resources.total} lines   ${pc.bold("whole SDK")} ${colour(
    all.lines.pct,
  )(
    `${all.lines.pct.toFixed(1)}%`,
  )} of ${all.lines.total} lines   ${pc.dim(path.relative(process.cwd(), path.join(repoRoot, "coverage/walk/index.html")))}`,
);
