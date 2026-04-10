import { Polly, Timing } from "@pollyjs/core";
import FetchAdapter from "@pollyjs/adapter-fetch";
import NodeHTTPAdapter from "@pollyjs/adapter-node-http";
import FSPersister from "@pollyjs/persister-fs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Register adapters and persister globally
Polly.register(FetchAdapter);
Polly.register(NodeHTTPAdapter);
Polly.register(FSPersister);

type PollyMode = "record" | "replay" | "passthrough";

const SENSITIVE_HEADERS = [
  "authorization",
  "api-key",
  "x-api-key",
  "api_key",
  "space_id",
  "x-stainless-api-key",
  "anthropic-api-key",
  "cookie",
  "set-cookie",
  "openai-organization",
  "openai-project",
];

export interface SetupPollyOptions {
  recordingName: string;
  adapters?: ("fetch" | "node-http")[];
}

export function getPollyMode(): PollyMode {
  const mode = (process.env.POLLY_MODE || "replay") as PollyMode;
  if (mode !== "record" && mode !== "replay" && mode !== "passthrough") {
    throw new Error(
      `Invalid POLLY_MODE: ${mode}. Must be 'record', 'replay', or 'passthrough'.`,
    );
  }
  return mode;
}

export function setupPolly({
  recordingName,
  adapters = ["fetch", "node-http"],
}: SetupPollyOptions): Polly {
  const mode = getPollyMode();

  const polly = new Polly(recordingName, {
    mode,
    adapters,
    persister: "fs",
    persisterOptions: {
      fs: {
        recordingsDir: path.resolve(__dirname, "recordings"),
      },
    },
    recordIfMissing: mode === "record",
    recordFailedRequests: true,
    flushRequestsOnStop: true,
    timing: Timing.fixed(0),
    logLevel: "silent",
    matchRequestsBy: {
      method: true,
      headers: false,
      body: true,
      order: false,
      url: {
        protocol: true,
        hostname: true,
        pathname: true,
        query: true,
        port: false,
        hash: false,
      },
    },
  });

  // Sanitize sensitive headers and cookies from recordings before persisting
  polly.server.any().on("beforePersist", (_req: unknown, recording: any) => {
    if (recording.request?.headers) {
      for (const header of recording.request.headers) {
        if (SENSITIVE_HEADERS.includes(header.name.toLowerCase())) {
          header.value = "REDACTED";
        }
      }
    }
    if (recording.response?.headers) {
      for (const header of recording.response.headers) {
        if (SENSITIVE_HEADERS.includes(header.name.toLowerCase())) {
          header.value = "REDACTED";
        }
      }
    }
    // Strip cookies from response (Polly stores them as a separate array)
    if (recording.response?.cookies) {
      recording.response.cookies = [];
    }
  });

  // OTLP trace endpoints have dynamic trace/span IDs in the body,
  // so we intercept them with a mock 200 response instead of replaying.
  polly.server
    .any()
    .filter((req: any) => /\/v1\/traces(\/|$)/.test(req.url))
    .intercept((_req: any, res: any) => {
      res.status(200);
      res.headers["content-type"] = "application/json";
      res.body = "{}";
    });

  return polly;
}

/**
 * Check if a recording exists on disk for the given name.
 * Polly.js persister-fs may append a hash to the directory name,
 * so we check for any directory starting with the recording name.
 */
export function hasRecording(recordingName: string): boolean {
  const recordingsDir = path.resolve(__dirname, "recordings");
  if (!fs.existsSync(recordingsDir)) return false;
  const entries = fs.readdirSync(recordingsDir);
  return entries.some(
    (entry) =>
      (entry === recordingName || entry.startsWith(recordingName + "_")) &&
      fs.existsSync(path.join(recordingsDir, entry, "recording.har")),
  );
}

/**
 * Ensure environment variables have values for replay mode.
 * In replay mode, sets dummy values for missing env vars so tests don't skip.
 * Pass recordingName to also check that the recording exists (skip if not).
 * Returns true if all vars are set (either real or dummy) and recording is available.
 * Returns false if in record/passthrough mode and vars are missing,
 * or if in replay mode and the recording doesn't exist.
 */
export function ensureEnvVarsForReplay(
  vars: string[],
  recordingName?: string,
): boolean {
  const mode = getPollyMode();

  if (mode === "replay") {
    // Can't replay without a recording
    if (recordingName && !hasRecording(recordingName)) {
      return false;
    }
    for (const v of vars) {
      if (!process.env[v]) {
        process.env[v] = `polly-replay-dummy-${v}`;
      }
    }
    return true;
  }

  // In record/passthrough mode, all vars must be real
  return vars.every((v) => !!process.env[v]);
}
