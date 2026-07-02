import { Polly, Timing } from "@pollyjs/core";
import FetchAdapter from "@pollyjs/adapter-fetch";
import NodeHTTPAdapter from "@pollyjs/adapter-node-http";
import FSPersister from "@pollyjs/persister-fs";
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Register adapters and persister globally
Polly.register(FetchAdapter);
Polly.register(NodeHTTPAdapter);
Polly.register(FSPersister);

type PollyMode = "record" | "replay" | "passthrough";

// Kept in sync with the Python SDK's cassette scrubbing
// (introspection-python-sdk `tests/conftest.py` SENSITIVE_HEADERS) so both
// SDKs redact the same credential headers from recordings.
const SENSITIVE_HEADERS = [
  "authorization",
  "api-key",
  "api_key",
  "x-api-key",
  "x-bt-api-key",
  "x-stainless-api-key",
  "anthropic-api-key",
  "anthropic-organization-id",
  "x-goog-api-key",
  "x-goog-user-project",
  "x-langfuse-public-key",
  "space_id",
  "cookie",
  "set-cookie",
  "openai-organization",
  "openai-project",
];

// Belt-and-suspenders over the explicit list: any header whose name *looks*
// like a credential is redacted too, so a new provider's auth header can never
// slip into a recording just because it wasn't enumerated above.
const SENSITIVE_HEADER_PATTERN =
  /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|\btoken\b|secret|password|credential|cookie|x-goog-user-project|session)/i;

function isSensitiveHeader(name: string): boolean {
  const n = name.toLowerCase();
  return SENSITIVE_HEADERS.includes(n) || SENSITIVE_HEADER_PATTERN.test(n);
}

// Mirror of the Python SDK's single source of truth for secret scrubbing
// (introspection-python-sdk `introspection_sdk/testing/redaction.py`
// SECRET_PATTERNS): identical regexes and identical REDACTED_* placeholders,
// so a secret is scrubbed the same way whether it lands in a JS or Python
// cassette. Keep the two lists in lockstep. Scrubbing runs only on record
// (beforePersist); replay never mutates committed fixtures.
const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-proj-[A-Za-z0-9_-]{20,}/g, "REDACTED_OPENAI_KEY"],
  [/AIza[A-Za-z0-9_-]{35}/g, "REDACTED_GOOGLE_KEY"],
  [/sk-ant-api\d+-[A-Za-z0-9_-]{20,}/g, "REDACTED_ANTHROPIC_KEY"],
  [/sk-D8K[A-Za-z0-9_-]{20,}/g, "REDACTED_BRAINTRUST_KEY"],
  [/lsv2_pt_[a-f0-9]{32}_[a-f0-9]+/g, "REDACTED_LANGSMITH_KEY"],
  [/sk-lf-[a-f0-9-]{36}/g, "REDACTED_LANGFUSE_SECRET"],
  [/pk-lf-[a-f0-9-]{36}/g, "REDACTED_LANGFUSE_PUBLIC"],
  [/ak-[a-f0-9-]{36}-[A-Za-z0-9_-]+/g, "REDACTED_ARIZE_KEY"],
  [/intro_dev_[A-Za-z0-9_-]{20,}/g, "REDACTED_INTROSPECTION_TOKEN"],
];

function scrubSecrets(text: string | undefined | null): string | undefined {
  if (!text) return text ?? undefined;
  let out = text;
  for (const [re, replacement] of SECRET_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

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

  // Sanitize sensitive headers, cookies, and secret-shaped values from
  // recordings before persisting, so no credential is ever committed.
  polly.server.any().on("beforePersist", (_req: unknown, recording: any) => {
    for (const header of recording.request?.headers ?? []) {
      if (isSensitiveHeader(header.name)) header.value = "REDACTED";
    }
    for (const header of recording.response?.headers ?? []) {
      if (isSensitiveHeader(header.name)) header.value = "REDACTED";
    }
    // Strip cookies from response (Polly stores them as a separate array)
    if (recording.response?.cookies) {
      recording.response.cookies = [];
    }
    // Scrub secret-shaped tokens from request/response bodies and the URL,
    // in case a provider echoes a credential outside the known headers.
    if (recording.request?.postData?.text !== undefined) {
      recording.request.postData.text = scrubSecrets(
        recording.request.postData.text,
      );
    }
    if (recording.response?.content?.text !== undefined) {
      recording.response.content.text = scrubSecrets(
        recording.response.content.text,
      );
    }
    if (typeof recording.request?.url === "string") {
      recording.request.url = scrubSecrets(recording.request.url);
    }
    for (const q of recording.request?.queryString ?? []) {
      if (typeof q.value === "string") q.value = scrubSecrets(q.value);
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
 * Install a clean set of OTel globals (context manager + W3C propagator)
 * for a single test scope, and return a disposer.
 *
 * Why this exists: OTel's `setGlobalContextManager` / `setGlobalPropagator`
 * silently refuse to replace an existing registration — they return false
 * and leave the prior value in place. That makes test isolation fragile:
 * if any earlier code in the same worker called
 * `NodeTracerProvider.register()` (which auto-installs both), or registered
 * globals without cleaning up, subsequent tests inherit stale state and
 * `withAgent` / `withConversation` baggage scopes silently don't take.
 *
 * This helper enforces a clean slate by calling `disable()` first, then
 * registering, then asserting that the registration actually took.
 * A loud throw beats silent baggage drops.
 *
 * Usage:
 *
 *   beforeEach(() => {
 *     dispose = installTestOTelGlobals();
 *   });
 *   afterEach(() => dispose());
 */
export function installTestOTelGlobals(): () => void {
  context.disable();
  propagation.disable();
  trace.disable();

  const ok =
    context.setGlobalContextManager(
      new AsyncLocalStorageContextManager().enable(),
    ) &&
    propagation.setGlobalPropagator(
      new CompositePropagator({
        propagators: [
          new W3CTraceContextPropagator(),
          new W3CBaggagePropagator(),
        ],
      }),
    );

  if (!ok) {
    throw new Error(
      "[polly-setup] OTel globals refused replacement after disable() — " +
        "registry is stuck. Tests cannot reliably propagate baggage; " +
        "failing loud rather than silently producing spans without identity.",
    );
  }

  return () => {
    context.disable();
    propagation.disable();
    trace.disable();
  };
}

/**
 * Canonical base URLs that test code should pass to SDK clients so the URL
 * each SDK posts to is identical between record and replay — independent of
 * what `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` etc. happen to be in the
 * host shell (Claude Code on the web pre-sets `ANTHROPIC_BASE_URL`, some
 * AnyLLM dev setups too).
 *
 * Each entry maps to the SDK's `baseURL`/`anthropicApiUrl` option, NOT to
 * the full request URL — the SDK appends its own path. Different SDKs split
 * the URL differently (e.g. the Anthropic Node SDK appends `/v1/messages`
 * while `@ai-sdk/anthropic` appends just `/messages`), hence the separate
 * entries per SDK family.
 *
 * Usage:
 *
 *   const client = new Anthropic({ baseURL: pollyEndpoints.anthropic.node });
 *   const model = new ChatAnthropic({
 *     anthropicApiUrl: pollyEndpoints.anthropic.langchain,
 *   });
 *   const m = openai({ baseURL: pollyEndpoints.openai.aiSdk })("gpt-5-nano");
 */
export const pollyEndpoints = {
  anthropic: {
    /** Anthropic Node SDK appends `/v1/messages` itself. */
    node: "https://api.anthropic.com",
    /** `@langchain/anthropic` uses the same base as the Node SDK. */
    langchain: "https://api.anthropic.com",
    /** `@ai-sdk/anthropic` appends just `/messages` — base must include /v1. */
    aiSdk: "https://api.anthropic.com/v1",
  },
  openai: {
    /** OpenAI Node SDK and `@ai-sdk/openai` use the same base. */
    node: "https://api.openai.com/v1",
    aiSdk: "https://api.openai.com/v1",
  },
} as const;

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
