/**
 * Tests the API contract check and the drift alert without staging, so CI can
 * run it on every pull request. A local server serves the references: built
 * here from the routes the SDK calls plus operations it never calls, one for
 * each `x-introspection` shape, or a 404, a 500 or a body that is not JSON.
 *
 * - An uncalled operation without `x-introspection`, or with "sdk" in its
 *   clients, is listed; one with `clients: []` or only other clients is not.
 *   With `--pr` the listed ones do not fail; without it, they fail. A route
 *   missing from the references fails either way.
 * - `/health` in both planes is not an ambiguous route.
 * - The data plane reference is `$STAGING_DP_URL/openapi.json`; with neither
 *   it nor an override set, the check exits 2 and names the variable.
 * - Any failure reading a reference, 404 included, exits 2 without a state.
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
/** Uncalled operations, by whether the check must require them. */
const UNCALLED = {
  "/v1/every-client": [true, undefined],
  "/v1/sdk-client": [true, { clients: ["sdk", "cli"] }],
  "/v1/no-client": [false, { clients: [] }],
  "/v1/cli-client": [false, { clients: ["cli"] }],
};
const health = { get: { "x-introspection": { clients: [] } } };

const documents = {
  empty: { paths: {} },
  health: { paths: { "/health": health } },
};
let posts = 0;
const server = createServer((req, res) => {
  if (req.method === "POST") {
    posts += 1;
    res.writeHead(200).end("ok");
    return;
  }
  // /<mode>/<plane>.json, or /<mode>/openapi.json for STAGING_DP_URL
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

/**
 * The check, with each plane's reference served in `modes`, or `env` in
 * place of those URLs.
 */
async function check(modes, args = [], env = undefined) {
  const out = mkdtempSync(resolve(tmpdir(), "api-contract-"));
  const result = await run(
    process.execPath,
    ["scripts/check-api-contract.mjs", "--out", out, ...args],
    env ??
      Object.fromEntries(
        PLANES.map((plane) => [
          `API_CONTRACT_${plane.toUpperCase()}`,
          `${base}/${modes[plane] ?? modes}/${plane}.json`,
        ]),
      ),
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
const empty = await check("empty", ["--pr"]);
const calls = [
  ...empty.output.matchAll(/^ {6}(GET|POST|PUT|PATCH|DELETE) (\S+)/gm),
];
expect(
  "a route missing from the references fails, also with --pr",
  empty.status === 1 && calls.length > 0,
  empty.output,
);
const paths = { "/health": health };
for (const [path, [, mark]] of Object.entries(UNCALLED)) {
  paths[path] = { get: mark ? { "x-introspection": mark } : {} };
}
for (const [, method, path] of calls) {
  const template = path.replace(/\{[^}]*\}/g, "{}");
  paths[template] = { ...paths[template], [method.toLowerCase()]: {} };
}
documents.ok = { paths };

const listsUncalled = (output) =>
  Object.entries(UNCALLED).every(
    ([path, [required]]) =>
      output.includes(`dataplane: GET ${path}\n`) === required,
  );
const pr = await check({ dataplane: "ok", controlplane: "health" }, ["--pr"]);
expect(
  "with --pr, uncalled operations for every client or sdk are listed but do not fail",
  pr.status === 0 &&
    listsUncalled(pr.output) &&
    !pr.output.includes("declared twice"),
  pr.output,
);
const full = await check({ dataplane: "ok", controlplane: "health" });
expect(
  "without --pr, they fail",
  full.status === 1 &&
    listsUncalled(full.output) &&
    readFileSync(resolve(full.out, "state"), "utf8").trim() === "red",
  full.output,
);

const fromDpUrl = await check(undefined, ["--pr"], {
  API_CONTRACT_DATAPLANE: "",
  API_CONTRACT_CONTROLPLANE: `${base}/health/controlplane.json`,
  STAGING_DP_URL: `${base}/ok/`,
});
expect(
  "the data plane reference is $STAGING_DP_URL/openapi.json",
  fromDpUrl.status === 0 &&
    fromDpUrl.output.includes(`${base}/ok/openapi.json`),
  fromDpUrl.output,
);
const noDpUrl = await check(undefined, [], {
  API_CONTRACT_DATAPLANE: "",
  API_CONTRACT_CONTROLPLANE: `${base}/health/controlplane.json`,
  STAGING_DP_URL: "",
});
expect(
  "an unset STAGING_DP_URL exits 2 and names it",
  noDpUrl.status === 2 &&
    !noDpUrl.state &&
    noDpUrl.output.includes("STAGING_DP_URL is not set"),
  noDpUrl.output,
);

for (const modes of [
  "missing",
  { dataplane: "ok", controlplane: "missing" },
  { dataplane: "ok", controlplane: "500" },
  { dataplane: "ok", controlplane: "bad" },
]) {
  const result = await check(modes);
  expect(
    `an unreadable reference exits 2 without a state (${JSON.stringify(modes)})`,
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
