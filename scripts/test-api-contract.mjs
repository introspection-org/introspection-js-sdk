/**
 * Tests the API contract check and the nightly drift run without staging, so
 * CI can run it on every pull request. The references come from the saved
 * snapshots in api-reference/, served by a local server that can also answer
 * 404, 500 or a body that is not JSON.
 *
 * - The check runs to its summary against the snapshots (drift or not: the
 *   SDK's drift is the nightly run's business, a crash is this test's).
 * - A reference that answers 404 makes the drift report skip: exit 0, no
 *   state. Any other failure reading one exits 2, also without a state.
 * - The first post, with no state recorded yet, posts a red state once and
 *   records it; the next red run stays quiet.
 *
 * Run: pnpm test:api-contract
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLANES = ["dataplane", "controlplane"];

let posts = 0;
const server = createServer((req, res) => {
  if (req.method === "POST") {
    posts += 1;
    res.writeHead(200).end("ok");
    return;
  }
  // /<mode>/<plane>.json
  const [, mode, file] = req.url.split("/");
  if (mode === "404") res.writeHead(404).end("Not Found");
  else if (mode === "500") res.writeHead(500).end("Internal Server Error");
  else if (mode === "bad") res.writeHead(200).end("<html>not json</html>");
  else
    res.writeHead(200).end(readFileSync(resolve(ROOT, "api-reference", file)));
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

const failures = [];
function expect(name, ok, output) {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failures.push(`${name}\n${output}`);
}

const check = await run(process.execPath, [
  "scripts/check-api-contract.mjs",
  ...PLANES.flatMap((plane) => [`--${plane}`, `api-reference/${plane}.json`]),
]);
expect(
  "the check runs to its summary against the snapshots",
  [0, 1].includes(check.status) &&
    /^(summary: |✓ SDK routes match)/m.test(check.output),
  check.output,
);

/** The drift report, with each plane's reference served in `modes`. */
async function report(modes) {
  const out = mkdtempSync(resolve(tmpdir(), "api-drift-"));
  const env = Object.fromEntries(
    PLANES.map((plane) => [
      `API_CONTRACT_${plane.toUpperCase()}`,
      `${base}/${modes[plane]}/${plane}.json`,
    ]),
  );
  const result = await run(
    process.execPath,
    ["scripts/api-drift-report.mjs", "--out", out],
    env,
  );
  return { ...result, state: existsSync(resolve(out, "state")) };
}

for (const modes of [
  { dataplane: "404", controlplane: "404" },
  { dataplane: "ok", controlplane: "404" },
]) {
  const result = await report(modes);
  expect(
    `a 404 skips the report (${JSON.stringify(modes)})`,
    result.status === 0 &&
      !result.state &&
      result.output.includes(
        "reference not published on staging yet, skipping",
      ),
    result.output,
  );
}
for (const mode of ["500", "bad"]) {
  const result = await report({ dataplane: "ok", controlplane: mode });
  expect(
    `a ${mode} reference fails the report`,
    result.status === 2 && !result.state,
    result.output,
  );
}

const reportDir = mkdtempSync(resolve(tmpdir(), "api-drift-report-"));
const stateDir = mkdtempSync(resolve(tmpdir(), "api-drift-state-"));
writeFileSync(resolve(reportDir, "state"), "red\n");
writeFileSync(resolve(reportDir, "body.txt"), "test body\n");
const notifyEnv = {
  REPORT_DIR: reportDir,
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
