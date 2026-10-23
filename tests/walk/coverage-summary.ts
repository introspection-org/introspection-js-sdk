/**
 * Print the walk's SDK coverage as terminal tables from the json-summary
 * `test:walk:cov` writes: the resource clients per package, worst first,
 * then the shared helpers they are built on, with the resources using each.
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

const resourceDir = (pkg: string) =>
  path.join(repoRoot, "packages", pkg, "src/resources");
const resourceName = (file: string) => path.basename(file, ".ts");

/**
 * A helper is a resources file another resource file imports, either
 * relatively or as a symbol re-exported from `@introspection-sdk/http`.
 */
function helperUsers(): Map<string, Set<string>> {
  const exportsOf = new Map<string, string[]>();
  const sources = new Map<string, string>();
  for (const pkg of PACKAGES) {
    for (const f of fs.readdirSync(resourceDir(pkg))) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      const file = path.join(resourceDir(pkg), f);
      const text = fs.readFileSync(file, "utf8");
      sources.set(file, text);
      exportsOf.set(
        file,
        [
          ...text.matchAll(
            /^export (?:async )?(?:function|class|const) (\w+)/gm,
          ),
        ].map((m) => m[1]!),
      );
    }
  }
  const users = new Map<string, Set<string>>();
  for (const [file, text] of sources) {
    for (const m of text.matchAll(
      /^import (?!type)\{([^}]*)\} from "(\.\/[\w-]+)\.js"|^import (?!type)\{([^}]*)\} from "@introspection-sdk\/http"/gm,
    )) {
      const targets = m[2]
        ? [path.join(path.dirname(file), `${m[2]}.ts`)]
        : [...exportsOf]
            .filter(([, names]) =>
              m[3]!.split(",").some((n) => names.includes(n.trim())),
            )
            .map(([f]) => f);
      for (const target of targets) {
        if (target === file || !exportsOf.has(target)) continue;
        const set = users.get(target) ?? new Set();
        set.add(resourceName(file));
        users.set(target, set);
      }
    }
  }
  return users;
}

const colour = (pct: number) =>
  pct >= 80 ? pc.green : pct >= 50 ? pc.yellow : pc.red;
const bar = (pct: number, width = 20) => {
  const full = Math.round((pct / 100) * width);
  return colour(pct)("█".repeat(full)) + pc.dim("░".repeat(width - full));
};
const cells = (e: Entry) => [
  bar(e.lines.pct),
  colour(e.lines.pct)(`${e.lines.pct.toFixed(1)}%`),
  pc.dim(`${e.lines.covered}/${e.lines.total}`),
];
const table = (head: string[], widths: number[]) =>
  new Table({
    head: head.map((h) => pc.bold(h)),
    colAligns: ["left", "left", "right", "right", "left"],
    colWidths: widths,
    wordWrap: true,
    style: { head: [], border: [] },
    chars: { mid: "", "left-mid": "", "mid-mid": "", "right-mid": "" },
  });

const helpers = helperUsers();
const entries = (pkg: string) =>
  Object.entries(summary)
    .filter(([file]) => file.startsWith(resourceDir(pkg) + path.sep))
    .filter(([, e]) => e.lines.total > 0)
    .sort(([, a], [, b]) => a.lines.pct - b.lines.pct);

const resources = { total: 0, covered: 0 };
for (const pkg of PACKAGES) {
  const t = table([pkg, "lines", "%", "covered", "funcs"], [20, 22, 8, 9, 7]);
  for (const [file, e] of entries(pkg)) {
    if (helpers.has(file)) continue;
    t.push([resourceName(file), ...cells(e), `${e.functions.pct.toFixed(0)}%`]);
    resources.total += e.lines.total;
    resources.covered += e.lines.covered;
  }
  console.log(t.toString());
}
const shared = table(
  ["shared helper", "lines", "%", "covered", "used by"],
  [20, 22, 8, 9, 30],
);
for (const pkg of PACKAGES) {
  for (const [file, e] of entries(pkg)) {
    const users = helpers.get(file);
    if (users)
      shared.push([
        resourceName(file),
        ...cells(e),
        [...users].sort().join(", "),
      ]);
  }
}
console.log(shared.toString());

const pct = (100 * resources.covered) / Math.max(resources.total, 1);
const all = summary.total!;
console.log(
  `${pc.bold("resources")} ${colour(pct)(`${pct.toFixed(1)}%`)} of ${resources.total} lines   ` +
    `${pc.bold("whole SDK")} ${colour(all.lines.pct)(`${all.lines.pct.toFixed(1)}%`)} of ${all.lines.total} lines   ` +
    pc.dim(
      path.relative(
        process.cwd(),
        path.join(repoRoot, "coverage/walk/index.html"),
      ),
    ),
);
// A replay skips the walk when the recording stops short, which reads as
// near-zero coverage rather than a failure.
if (pct < 5) {
  console.error(
    pc.red(
      "The walk barely ran: an incomplete recording skips it. Record again with test:walk:record.",
    ),
  );
  process.exit(1);
}
