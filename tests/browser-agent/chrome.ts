/**
 * Real headless Chromium for the browser-agent tests. The package drives a
 * browser over CDP, so there is nothing to record or mock: the tests launch a
 * browser, serve a fixture page, and assert on what the page actually does.
 *
 * Chromium is found through CHROME_PATH, then the usual install locations
 * (GitHub's Ubuntu runners ship google-chrome). Without one, the suites skip.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

function playwrightShells(): string[] {
  const root = "/opt/pw-browsers";
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => d.startsWith("chromium_headless_shell"))
    .map((d) => join(root, d, "chrome-linux", "headless_shell"));
}

export function findChrome(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    ...playwrightShells(),
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.find((p): p is string => !!p && existsSync(p)) ?? null;
}

export interface LaunchedChrome {
  endpoint: string;
  close(): Promise<void>;
}

export async function launchChrome(binary: string): Promise<LaunchedChrome> {
  const profile = mkdtempSync(join(tmpdir(), "browser-agent-test-"));
  const child: ChildProcess = spawn(
    binary,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--window-size=800,600",
      "about:blank",
    ],
    // Its own process group, so close() reaches the helper processes too.
    { stdio: "ignore", detached: true },
  );
  const portFile = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 15_000;
  while (!existsSync(portFile)) {
    if (Date.now() > deadline) throw new Error("Chromium did not start");
    await new Promise((r) => setTimeout(r, 50));
  }
  let port = "";
  while (!port) {
    port = readFileSync(portFile, "utf8").split("\n")[0] ?? "";
    if (!port) await new Promise((r) => setTimeout(r, 50));
  }
  return {
    endpoint: `http://127.0.0.1:${port}`,
    async close() {
      const exited =
        child.exitCode !== null || child.signalCode !== null
          ? Promise.resolve()
          : new Promise((r) => child.once("exit", r));
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // The group is already gone.
      }
      await exited;
      rmSync(profile, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    },
  };
}

export const FIXTURE_HTML = `<!doctype html>
<html><head><title>Stays</title>
<style>body{margin:0;font:16px sans-serif} .spacer{height:1400px}
#overlay{position:fixed;left:0;top:0;width:100%;height:60px;background:#fff;z-index:10}
#overlay.hidden{display:none}</style></head>
<body>
  <div id="overlay" class="hidden">Cookie banner</div>
  <form id="search" onsubmit="event.preventDefault(); results()">
    <label>Destination <input id="dest" type="search"></label>
    <label>Category <select id="cat"><option>All</option><option>Design</option><option>Nature</option></select></label>
    <label><input id="free" type="checkbox"> Free cancellation</label>
    <button type="submit">Search</button>
    <button type="button" disabled>Disabled action</button>
    <input id="upload" type="file" aria-label="Attachment">
  </form>
  <p id="count">no search yet</p>
  <a href="/second">Second page</a>
  <button type="button" onclick="document.getElementById('overlay').classList.remove('hidden')">Show banner</button>
  <div class="spacer"></div>
  <button type="button" id="far" onclick="document.getElementById('count').textContent='far clicked'">Far away</button>
  <script>
    function results() {
      const d = document.getElementById('dest').value;
      const c = document.getElementById('cat').value;
      const f = document.getElementById('free').checked;
      const file = document.getElementById('upload').files[0];
      document.getElementById('count').textContent =
        'searched ' + d + ' / ' + c + ' / ' + (f ? 'free' : 'any') + (file ? ' / ' + file.name : '');
    }
  </script>
</body></html>`;

export interface FixtureServer {
  url: string;
  close(): Promise<void>;
}

export async function serveFixture(): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/second") {
      res.end(
        "<!doctype html><title>Second</title><p>second page</p><button>Only here</button>",
      );
      return;
    }
    res.end(FIXTURE_HTML);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
