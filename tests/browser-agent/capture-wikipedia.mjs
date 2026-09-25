// Captures a live Jev run on en.wikipedia.org as replayable steps: the real
// observations, the history Jev saw, and the decision it made. Handles are
// renamed per page (el_p<page>_<n>) so the fixture is stable. Nothing secret is
// written: observations are public page content, and the key stays in env.
//
//   CHROME_PATH=… TYPESAFE_API_KEY=… node browser-agent/capture-wikipedia.mjs \
//     browser-agent/fixtures/wikipedia-chromium.json
//
// HTTPS_PROXY, when set, is passed to Chromium.
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserSession,
  JevDriver,
  run,
} from "@introspection-sdk/browser-agent";

const out = process.argv[2];
const profile = mkdtempSync(join(tmpdir(), "cap-"));
const chrome = spawn(
  process.env.CHROME_PATH ?? "google-chrome",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    ...(process.env.HTTPS_PROXY
      ? [`--proxy-server=${process.env.HTTPS_PROXY}`]
      : []),
    "--window-size=1280,900",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
while (!existsSync(join(profile, "DevToolsActivePort")))
  await new Promise((r) => setTimeout(r, 50));
let port = "";
while (!port)
  port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split(
    "\n",
  )[0];

const pages = new Map();
const rename = (s) =>
  s?.replace(/el_([a-z0-9]+)_(\d+)/g, (_, doc, n) => {
    if (!pages.has(doc)) pages.set(doc, `p${pages.size + 1}`);
    return `el_${pages.get(doc)}_${n}`;
  });
const deep = (v) => JSON.parse(rename(JSON.stringify(v)));
const goal = "Search Wikipedia for Chromium and open its article";
const steps = [];
try {
  const session = await BrowserSession.connect(`http://127.0.0.1:${port}`, {
    allowedDomains: ["en.wikipedia.org"],
  });
  await session.navigate({ url: "https://en.wikipedia.org/wiki/Main_Page" });
  let history = [];
  const result = await run(session, {
    goal,
    drivers: [
      new JevDriver({
        apiKey: process.env.TYPESAFE_API_KEY,
        slots: { search: "Chromium" },
      }),
    ],
    success: (p) => p.url.startsWith("https://en.wikipedia.org/wiki/Chromium"),
    maxSteps: 10,
    onStep(step, observation) {
      const { op, element, text, keys, error } = step;
      steps.push(
        deep({
          observation,
          history: history.map(({ op, element, text }) => ({
            op,
            element,
            text,
          })),
          decision: { op, element, text, keys },
          error,
        }),
      );
      history = [...history, step];
    },
  });
  console.log(
    result.status,
    result.steps.length,
    result.url,
    steps.map(
      (s) => `${s.decision.op} ${s.decision.element ?? ""} ${s.error ?? ""}`,
    ),
  );
  writeFileSync(
    out,
    JSON.stringify(
      {
        goal,
        slots: { search: "Chromium" },
        captured: new Date().toISOString().slice(0, 10),
        status: result.status,
        steps,
      },
      null,
      2,
    ) + "\n",
  );
  session.close();
} finally {
  chrome.kill("SIGKILL");
}
