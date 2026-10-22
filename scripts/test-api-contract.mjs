/**
 * Tests the API contract check and the drift alert without staging, so CI can
 * run it on every pull request. A local server serves the references: built
 * here from the routes the SDK calls plus one `sdk` operation it never calls,
 * or a 404, a 500 or a body that is not JSON.
 *
 * - With `--pr`, the uncalled operation is listed but does not fail; without
 *   it, it fails. A route missing from the references fails either way.
 * - A reference that answers 404 skips: exit 0, no state. Any other failure
 *   reading one exits 2, also without a state.
 * - The first red run, with no state recorded yet, posts once and records
 *   red; the next red run stays quiet.
 *
 * Run: pnpm test:api-contract
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLANES = ["dataplane", "controlplane"];
const UNCALLED = "/v1/never-called";

const documents = { empty: { paths: {} } };
let posts = 0;
const server = createServer((req, res) => {
  if (req.method === "POST") {
    posts += 1;
    res.writeHead(200).end("ok");
    return;
  }
  // /<mode>/<plane>.json
  const [, mode] = req.url.split("/");
  if (mode === "500") res.writeHead(500).end("Internal Server Error");
  else if (mode === "bad") res.writeHead(200).end("<html>not json</html>");
  else if (documents[mode]) res.end(JSON.stringify(documents[mode]));
  else res.writeHead(404).end("Not Found");
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;

/** Runs a command to its end, without blocking the server above. */
function run(command, args, env = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", fail);
    child.on("close", (status) => done({ status, output }));
  });
}

/** The check, with each plane's reference served in `modes`. */
async function check(modes, ...args) {
  const out = mkdtempSync(resolve(tmpdir(), "api-contract-"));
  const env = Object.fromEntries(
    PLANES.map((plane) => [
      `API_CONTRACT_${plane.toUpperCase()}`,
      `${base}/${modes[plane] ?? modes}/${plane}.json`,
    ]),
  );
  const result = await run(
    process.execPath,
    ["scripts/check-api-contract.mjs", "--out", out, ...args],
    env,
  );
  return { ...result, out, state: existsSync(resolve(out, "state")) };
}

const failures = [];
function expect(name, ok, output) {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failures.push(`${name}\n${output}`);
}

// Against empty references, every route the SDK calls is missing; those
// routes, plus one uncalled `sdk` operation, make the reference below.
const empty = await check("empty", "--pr");
const calls = [
  ...empty.output.matchAll(/^ {6}(GET|POST|PUT|PATCH|DELETE) (\S+)/gm),
];
expect(
  "a route missing from the references fails, also with --pr",
  empty.status === 1 && calls.length > 0,
  empty.output,
);
const paths = {
  [UNCALLED]: { get: { "x-introspection": { clients: ["sdk"] } } },
};
for (const [, method, path] of calls) {
  const template = path.replace(/\{[^}]*\}/g, "{}");
  paths[template] = { ...paths[template], [method.toLowerCase()]: {} };
}
documents.ok = { paths };

const pr = await check({ dataplane: "ok", controlplane: "empty" }, "--pr");
expect(
  "with --pr, an uncalled sdk operation is listed but does not fail",
  pr.status === 0 && pr.output.includes(`dataplane: GET ${UNCALLED}`),
  pr.output,
);
const full = await check({ dataplane: "ok", controlplane: "empty" });
expect(
  "without --pr, an uncalled sdk operation fails",
  full.status === 1 &&
    readFileSync(resolve(full.out, "state"), "utf8").trim() === "red",
  full.output,
);

for (const modes of ["missing", { dataplane: "ok", controlplane: "missing" }]) {
  const result = await check(modes);
  expect(
    `a 404 skips (${JSON.stringify(modes)})`,
    result.status === 0 &&
      !result.state &&
      result.output.includes("reference not published yet, skipping"),
    result.output,
  );
}
for (const mode of ["500", "bad"]) {
  const result = await check({ dataplane: "ok", controlplane: mode });
  expect(
    `a ${mode} reference exits 2`,
    result.status === 2 && !result.state,
    result.output,
  );
}

const stateDir = mkdtempSync(resolve(tmpdir(), "api-drift-state-"));
const notifyEnv = {
  REPORT_DIR: full.out,
  STATE_DIR: stateDir,
  SLACK_WEBHOOK_URL: `${base}/webhook`,
  GITHUB_OUTPUT: "",
};
const first = await run("scripts/api-drift-notify.sh", [], notifyEnv);
expect(
  "the first red run, with no state yet, posts and records red",
  first.status === 0 &&
    posts === 1 &&
    readFileSync(resolve(stateDir, "last-posted"), "utf8").trim() === "red",
  first.output,
);
const second = await run("scripts/api-drift-notify.sh", [], notifyEnv);
expect(
  "the next red run stays quiet",
  second.status === 0 && posts === 1,
  second.output,
);

server.close();
if (failures.length) {
  console.error(`\n${failures.join("\n\n")}`);
  process.exit(1);
}
