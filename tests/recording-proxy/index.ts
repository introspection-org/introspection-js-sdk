/**
 * Local HTTP recording proxy for SDKs that bypass Polly's in-process
 * adapters (the Claude Agent SDK is the motivating case — its `claude`
 * binary calls Anthropic's API from a subprocess so there's no in-process
 * fetch / node-http call for Polly to intercept).
 *
 * Storage format is Polly's HAR 1.2 shape on disk:
 *
 *   tests/recordings/<name>/recording.har
 *
 * (Identical layout to Polly's persister-fs output, so any HAR-aware tool
 * — Polly itself, har-viewer, browser DevTools — can inspect a recording
 * without special handling.)
 *
 * Matching is order-based per (method, url): the proxy iterates the
 * entries in the HAR, and for each incoming request it serves the next
 * unconsumed entry whose method + url matches. Bodies are persisted
 * (scrubbed) for human inspection but intentionally NOT used for
 * matching — SDKs like the Claude Agent SDK auto-inject machine-specific
 * content into request bodies (default system prompt, tool registrations,
 * billing nonces) which would otherwise make replays brittle across
 * environments. The (method, url, order) tuple is stable across runs;
 * the body is not.
 *
 * Mode is taken from the `POLLY_MODE` env var (record / replay), so the
 * UX matches the existing Polly tests:
 *
 *   POLLY_MODE=record pnpm test -- <test-file>   # capture HARs once
 *   pnpm test -- <test-file>                     # default: replay
 */

import http from "node:http";
import https from "node:https";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { scrubBody, scrubHeaders } from "./scrub.js";

export type ProxyMode = "record" | "replay";

export interface StartProxyOptions {
  /** Unique name; becomes the recordings subdirectory. */
  name: string;
  /** Upstream base URL, e.g. "https://api.anthropic.com". Required for record mode. */
  upstream?: string;
  /** Override mode; defaults to POLLY_MODE env var, then "replay". */
  mode?: ProxyMode;
  /** Override the recordings directory. */
  recordingsDir?: string;
}

export interface Proxy {
  /** URL the SDK should point at, e.g. http://127.0.0.1:51234. */
  url: string;
  /** Stop the listener (in record mode, flushes the HAR to disk). */
  stop: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// HAR 1.2 types (subset we use)
// ---------------------------------------------------------------------------

interface HarNameValue {
  name: string;
  value: string;
}

interface HarRequest {
  method: string;
  url: string;
  httpVersion: string;
  headers: HarNameValue[];
  queryString: HarNameValue[];
  cookies: HarNameValue[];
  headersSize: -1;
  bodySize: number;
  postData?: {
    mimeType: string;
    text: string;
  };
}

interface HarResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: HarNameValue[];
  cookies: HarNameValue[];
  content: {
    size: number;
    mimeType: string;
    text: string;
    encoding?: "base64";
  };
  redirectURL: string;
  headersSize: -1;
  bodySize: number;
}

interface HarEntry {
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
  cache: Record<string, never>;
  timings: { send: 0; wait: number; receive: 0 };
}

interface HarLog {
  version: "1.2";
  creator: { name: string; version: string };
  entries: HarEntry[];
}

interface HarFile {
  log: HarLog;
}

// ---------------------------------------------------------------------------
// Resolve recordings location relative to this module so behavior is
// independent of process.cwd() — same trick polly-setup.ts uses.
// ---------------------------------------------------------------------------

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const RECORDINGS_ROOT = resolve(MODULE_DIR, "..", "recordings");

function defaultRecordingsDir(name: string): string {
  return join(RECORDINGS_ROOT, name);
}

function harFilePath(recordingsDir: string): string {
  return join(recordingsDir, "recording.har");
}

function emptyHar(): HarFile {
  return {
    log: {
      version: "1.2",
      creator: { name: "introspection-recording-proxy", version: "1.0" },
      entries: [],
    },
  };
}

async function loadHar(file: string): Promise<HarFile | null> {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, "utf8")) as HarFile;
  } catch {
    return null;
  }
}

async function saveHar(file: string, har: HarFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(har, null, 2));
}

function objToHarHeaders(headers: Record<string, string>): HarNameValue[] {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function harHeadersToObj(headers: HarNameValue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) out[h.name] = h.value;
  return out;
}

function normalizeHeaders(
  raw: http.IncomingHttpHeaders,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * Forward to upstream and stream chunks back to the client as they arrive,
 * while also buffering the full body so the recording captures it.
 */
function forwardAndCapture(
  upstream: string,
  method: string,
  url: string,
  headers: Record<string, string>,
  body: Buffer,
  clientRes: http.ServerResponse,
): Promise<UpstreamResponse> {
  const upstreamUrl = new URL(url, upstream);
  const fwdHeaders: Record<string, string> = { ...headers };
  delete fwdHeaders["host"];
  delete fwdHeaders["content-length"];
  fwdHeaders["host"] = upstreamUrl.host;

  return new Promise<UpstreamResponse>((resolveP, rejectP) => {
    const req = https.request(
      {
        method,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || 443,
        path: upstreamUrl.pathname + upstreamUrl.search,
        headers: fwdHeaders,
      },
      (res) => {
        const chunks: Buffer[] = [];
        const respHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          respHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v);
        }
        clientRes.writeHead(res.statusCode ?? 500, respHeaders);
        res.on("data", (c: Buffer) => {
          chunks.push(c);
          clientRes.write(c);
        });
        res.on("end", () => {
          clientRes.end();
          resolveP({
            status: res.statusCode ?? 500,
            headers: respHeaders,
            body: Buffer.concat(chunks),
          });
        });
        res.on("error", rejectP);
      },
    );
    req.on("error", rejectP);
    req.write(body);
    req.end();
  });
}

function isTextContentType(ct: string | undefined): boolean {
  if (!ct) return true;
  return /^(application\/(json|xml|.*\+json)|text\/)/i.test(ct);
}

export async function startProxy(opts: StartProxyOptions): Promise<Proxy> {
  const mode: ProxyMode =
    opts.mode ?? (process.env.POLLY_MODE === "record" ? "record" : "replay");
  const recordingsDir = opts.recordingsDir ?? defaultRecordingsDir(opts.name);
  const harPath = harFilePath(recordingsDir);
  const upstream = opts.upstream;

  if (mode === "record" && !upstream) {
    throw new Error("[recording-proxy] upstream is required for record mode");
  }

  // Replay state: load HAR once, advance per matching request.
  const replayHar = mode === "replay" ? await loadHar(harPath) : null;
  // Indexes already consumed during this proxy lifetime — supports the
  // order-based matching: same (method, url) request twice serves entries
  // [first match, second match] in that order, even if non-matching entries
  // appear between them in the HAR.
  const consumed = new Set<number>();

  // Record state: in-memory accumulator, flushed on stop().
  const recordHar: HarFile = emptyHar();

  const server = http.createServer(async (req, res) => {
    try {
      // SDK preflight — return 200 empty.
      if (req.method === "HEAD") {
        res.writeHead(200);
        res.end();
        return;
      }

      const url = req.url ?? "/";
      const method = (req.method ?? "GET").toUpperCase();
      const headers = normalizeHeaders(req.headers);
      const bodyBuf = await readBody(req);
      const bodyStr = bodyBuf.toString("utf8");

      if (mode === "replay") {
        if (!replayHar) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: "no recording found",
              hint: `expected ${harPath}; run with POLLY_MODE=record to capture.`,
            }),
          );
          return;
        }

        // Find the next unconsumed entry whose method + URL matches.
        const entries = replayHar.log.entries;
        let matchIdx = -1;
        for (let i = 0; i < entries.length; i++) {
          if (consumed.has(i)) continue;
          const e = entries[i];
          if (
            e.request.method.toUpperCase() === method &&
            e.request.url === url
          ) {
            matchIdx = i;
            break;
          }
        }

        if (matchIdx === -1) {
          // Log misses so the next record cycle is debuggable. Returning
          // 404 (terminal) instead of 5xx prevents SDK retry loops from
          // hanging the test.
          // eslint-disable-next-line no-console
          console.warn(
            `[recording-proxy] replay miss: ${method} ${url} (no unconsumed entry; ` +
              `${replayHar.log.entries.length} total in HAR). Re-record to capture.`,
          );
          res.writeHead(404, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: "no matching recording",
              method,
              url,
              har: harPath,
            }),
          );
          return;
        }

        consumed.add(matchIdx);
        const entry = entries[matchIdx];
        const respHeaders = harHeadersToObj(entry.response.headers);
        const body =
          entry.response.content.encoding === "base64"
            ? Buffer.from(entry.response.content.text, "base64")
            : Buffer.from(entry.response.content.text, "utf8");
        res.writeHead(entry.response.status, respHeaders);
        res.end(body);
        return;
      }

      // Record mode — forward, persist as HAR entry.
      const t0 = Date.now();
      const upstreamRes = await forwardAndCapture(
        upstream!,
        method,
        url,
        headers,
        bodyBuf,
        res,
      );
      const ct = upstreamRes.headers["content-type"];
      const isText = isTextContentType(ct);
      const reqMime = headers["content-type"] || "application/octet-stream";

      const entry: HarEntry = {
        startedDateTime: new Date(t0).toISOString(),
        time: Date.now() - t0,
        request: {
          method,
          url,
          httpVersion: "HTTP/1.1",
          headers: objToHarHeaders(scrubHeaders(headers)),
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: bodyBuf.length,
          postData: bodyBuf.length
            ? { mimeType: reqMime, text: scrubBody(bodyStr) }
            : undefined,
        },
        response: {
          status: upstreamRes.status,
          statusText: "",
          httpVersion: "HTTP/1.1",
          headers: objToHarHeaders(upstreamRes.headers),
          cookies: [],
          content: {
            size: upstreamRes.body.length,
            mimeType: ct ?? "application/octet-stream",
            text: isText
              ? upstreamRes.body.toString("utf8")
              : upstreamRes.body.toString("base64"),
            ...(isText ? {} : { encoding: "base64" as const }),
          },
          redirectURL: "",
          headersSize: -1,
          bodySize: upstreamRes.body.length,
        },
        cache: {},
        timings: { send: 0, wait: Date.now() - t0, receive: 0 },
      };
      recordHar.log.entries.push(entry);
    } catch (err) {
      const msg = err instanceof Error ? err.stack || err.message : String(err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "proxy error", detail: msg }, null, 2));
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolveP) => {
    server.listen(0, "127.0.0.1", () => resolveP());
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    stop: () =>
      new Promise<void>((resolveP, rejectP) => {
        server.close(async (err) => {
          if (err) {
            rejectP(err);
            return;
          }
          if (mode === "record" && recordHar.log.entries.length > 0) {
            try {
              await saveHar(harPath, recordHar);
            } catch (e) {
              rejectP(e);
              return;
            }
          }
          resolveP();
        });
      }),
  };
}
