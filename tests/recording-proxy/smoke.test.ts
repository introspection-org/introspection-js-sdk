/**
 * Smoke test for the recording proxy.
 *
 * Proves the proxy works end-to-end without needing a real Anthropic key:
 *   - Record mode forwards to api.anthropic.com and persists the response
 *     as a HAR entry.
 *   - Replay mode loads the HAR, serves entries in order by (method, url).
 *
 * The recorded 401 isn't a useful conversation fixture but exercises every
 * code path: HEAD preflight, POST forwarding, header scrubbing, HAR write,
 * HAR read, ordered replay.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startProxy } from "./index";

describe("recording-proxy smoke", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "proxy-smoke-"));
  });

  afterAll(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("HEAD preflight returns 200", async () => {
    const proxy = await startProxy({
      name: "head-preflight",
      mode: "replay",
      recordingsDir: join(tmpDir, "head"),
    });
    try {
      const r = await fetch(proxy.url, { method: "HEAD" });
      expect(r.status).toBe(200);
    } finally {
      await proxy.stop();
    }
  });

  it("replay returns 404 with a clear error when no HAR exists", async () => {
    const proxy = await startProxy({
      name: "missing-recording",
      mode: "replay",
      recordingsDir: join(tmpDir, "missing"),
    });
    try {
      const r = await fetch(`${proxy.url}/v1/messages`, {
        method: "POST",
        body: JSON.stringify({ test: true }),
      });
      expect(r.status).toBe(404);
      const body = (await r.json()) as { error: string };
      expect(body.error).toBe("no recording found");
    } finally {
      await proxy.stop();
    }
  });

  it("record writes a HAR file then replay serves entries in order", async () => {
    const recordingsDir = join(tmpDir, "round-trip");

    // Record — forward to upstream, persist as HAR.
    const recProxy = await startProxy({
      name: "round-trip",
      mode: "record",
      upstream: "https://api.anthropic.com",
      recordingsDir,
    });
    let recordedStatus = 0;
    try {
      const r = await fetch(`${recProxy.url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer sk-ant-fake-not-a-real-key-just-for-test",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 8,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      recordedStatus = r.status;
      await r.text();
    } finally {
      await recProxy.stop();
    }
    expect(recordedStatus).toBeGreaterThanOrEqual(400);
    expect(recordedStatus).toBeLessThan(500);

    // HAR should be present, in Polly's standard format.
    const harPath = join(recordingsDir, "recording.har");
    expect(existsSync(harPath)).toBe(true);
    const har = JSON.parse(readFileSync(harPath, "utf8"));
    expect(har.log.version).toBe("1.2");
    expect(har.log.entries.length).toBe(1);
    expect(har.log.entries[0].request.url).toBe("/v1/messages");

    // Replay — same request matches the single recorded entry.
    const replayProxy = await startProxy({
      name: "round-trip",
      mode: "replay",
      recordingsDir,
    });
    try {
      const r = await fetch(`${replayProxy.url}/v1/messages`, {
        method: "POST",
        body: "anything",
      });
      // Body intentionally different from record — matcher is method+url+order.
      expect(r.status).toBe(recordedStatus);
    } finally {
      await replayProxy.stop();
    }
  });

  it("ordered replay serves N entries to N matching calls in order", async () => {
    // Use a hand-rolled HAR so we don't need a real upstream — just verify
    // the per-URL ordering logic.
    const recordingsDir = join(tmpDir, "ordered");
    const harPath = join(recordingsDir, "recording.har");
    rmSync(recordingsDir, { recursive: true, force: true });
    require("node:fs").mkdirSync(recordingsDir, { recursive: true });
    require("node:fs").writeFileSync(
      harPath,
      JSON.stringify({
        log: {
          version: "1.2",
          creator: { name: "test", version: "0" },
          entries: [
            {
              startedDateTime: "2026-01-01T00:00:00Z",
              time: 0,
              request: {
                method: "POST",
                url: "/v1/messages",
                httpVersion: "HTTP/1.1",
                headers: [],
                queryString: [],
                cookies: [],
                headersSize: -1,
                bodySize: 0,
              },
              response: {
                status: 200,
                statusText: "",
                httpVersion: "HTTP/1.1",
                headers: [{ name: "content-type", value: "application/json" }],
                cookies: [],
                content: {
                  size: 14,
                  mimeType: "application/json",
                  text: '{"turn":"one"}',
                },
                redirectURL: "",
                headersSize: -1,
                bodySize: 14,
              },
              cache: {},
              timings: { send: 0, wait: 0, receive: 0 },
            },
            {
              startedDateTime: "2026-01-01T00:00:01Z",
              time: 0,
              request: {
                method: "POST",
                url: "/v1/messages",
                httpVersion: "HTTP/1.1",
                headers: [],
                queryString: [],
                cookies: [],
                headersSize: -1,
                bodySize: 0,
              },
              response: {
                status: 200,
                statusText: "",
                httpVersion: "HTTP/1.1",
                headers: [{ name: "content-type", value: "application/json" }],
                cookies: [],
                content: {
                  size: 14,
                  mimeType: "application/json",
                  text: '{"turn":"two"}',
                },
                redirectURL: "",
                headersSize: -1,
                bodySize: 14,
              },
              cache: {},
              timings: { send: 0, wait: 0, receive: 0 },
            },
          ],
        },
      }),
    );

    const proxy = await startProxy({
      name: "ordered",
      mode: "replay",
      recordingsDir,
    });
    try {
      const r1 = await (
        await fetch(`${proxy.url}/v1/messages`, { method: "POST" })
      ).json();
      const r2 = await (
        await fetch(`${proxy.url}/v1/messages`, { method: "POST" })
      ).json();
      expect(r1).toEqual({ turn: "one" });
      expect(r2).toEqual({ turn: "two" });
    } finally {
      await proxy.stop();
    }
  });
});
