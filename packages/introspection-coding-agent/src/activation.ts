/** Shared, fail-closed per-session activation protocol for coding-agent capture. */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";

import {
  coversHost,
  resolveTelemetryConfig,
  type CaptureHost,
} from "./config.js";

export const CAPTURE_ACTIVATION_VERSION = 1;

export interface CaptureActivationRequest {
  version: number;
  host: CaptureHost;
  sessionId: string;
  requestedAt: string;
}

export interface CaptureActivationMarker {
  version: number;
  host: CaptureHost;
  sessionId: string;
  transcriptIdentity: string;
  nativeTurnKey: string;
  byteOffset: number;
  device: string;
  inode: string;
  cwd?: string;
  gitBranch?: string;
  hostVersion?: string;
  entrypoint?: string;
  activatedAt: string;
}

export type CaptureActivationOutcome =
  | "requested"
  | "activated"
  | "no-consent"
  | "host-not-covered"
  | "request-missing"
  | "source-invalid"
  | "marker-write-failed";

export interface CaptureActivationResult {
  outcome: CaptureActivationOutcome;
  marker?: CaptureActivationMarker;
  detail?: string;
}

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "unknown";
}

export function transcriptIdentity(canonicalPath: string): string {
  return createHash("sha256").update(canonicalPath).digest("hex");
}

export function activationRequestPath(
  host: CaptureHost,
  sessionId: string,
  home: string = homedir(),
): string {
  return join(
    home,
    ".introspection",
    "capture-activation-requests",
    host,
    `${safeSessionId(sessionId)}.json`,
  );
}

export function captureActivationPath(
  host: CaptureHost,
  sessionId: string,
  sourceIdentity: string,
  home: string = homedir(),
): string {
  return join(
    home,
    ".introspection",
    "capture-activation",
    host,
    `${safeSessionId(sessionId)}-${sourceIdentity.slice(0, 32)}.json`,
  );
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

/** Invisible side effect used only by an Introspection-owned executable. */
export async function requestCaptureActivation(options: {
  host: CaptureHost;
  sessionId: string;
  home?: string;
}): Promise<CaptureActivationResult> {
  const home = options.home ?? homedir();
  const config = await resolveTelemetryConfig(home);
  if (!config.enabled) return { outcome: "no-consent" };
  if (!coversHost(config, options.host)) return { outcome: "host-not-covered" };
  const request: CaptureActivationRequest = {
    version: CAPTURE_ACTIVATION_VERSION,
    host: options.host,
    sessionId: options.sessionId,
    requestedAt: new Date().toISOString(),
  };
  try {
    await writePrivateJson(
      activationRequestPath(options.host, options.sessionId, home),
      request,
    );
    return { outcome: "requested" };
  } catch (error) {
    return {
      outcome: "marker-write-failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function clearCaptureActivationRequest(
  host: CaptureHost,
  sessionId: string,
  home: string = homedir(),
): Promise<void> {
  await unlink(activationRequestPath(host, sessionId, home)).catch(
    () => undefined,
  );
}

export async function requestCaptureActivationFromEnvironment(
  home: string = homedir(),
): Promise<CaptureActivationResult> {
  const codexSessionId = process.env.CODEX_THREAD_ID;
  const claudeSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (codexSessionId && claudeSessionId) {
    return {
      outcome: "source-invalid",
      detail: "host session id is ambiguous",
    };
  }
  if (codexSessionId) {
    return requestCaptureActivation({
      host: "codex",
      sessionId: codexSessionId,
      home,
    });
  }
  if (claudeSessionId) {
    return requestCaptureActivation({
      host: "claude-code",
      sessionId: claudeSessionId,
      home,
    });
  }
  return { outcome: "source-invalid", detail: "host session id is absent" };
}

async function readRequest(
  host: CaptureHost,
  sessionId: string,
  home: string,
): Promise<CaptureActivationRequest | undefined> {
  try {
    const value: unknown = JSON.parse(
      await readFile(activationRequestPath(host, sessionId, home), "utf8"),
    );
    if (typeof value !== "object" || value === null) return undefined;
    const request = value as CaptureActivationRequest;
    return request.version === CAPTURE_ACTIVATION_VERSION &&
      request.host === host &&
      request.sessionId === sessionId
      ? request
      : undefined;
  } catch {
    return undefined;
  }
}

interface SourceMetadata {
  sessionId: string;
  cwd?: string;
  gitBranch?: string;
  hostVersion?: string;
  entrypoint?: string;
}

async function sourceMetadata(
  host: CaptureHost,
  path: string,
): Promise<SourceMetadata | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const complete = buffer.subarray(0, bytesRead);
    let start = 0;
    while (start < complete.length) {
      const newline = complete.indexOf(0x0a, start);
      if (newline < 0) break;
      const value: unknown = JSON.parse(
        complete.subarray(start, newline).toString("utf8"),
      );
      start = newline + 1;
      if (typeof value !== "object" || value === null) continue;
      const record = value as Record<string, unknown>;
      if (host === "codex" && record.type === "session_meta") {
        const payload =
          typeof record.payload === "object" && record.payload !== null
            ? (record.payload as Record<string, unknown>)
            : undefined;
        if (typeof payload?.id !== "string") return undefined;
        const git =
          typeof payload.git === "object" && payload.git !== null
            ? (payload.git as Record<string, unknown>)
            : undefined;
        return {
          sessionId: payload.id,
          cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
          gitBranch: typeof git?.branch === "string" ? git.branch : undefined,
          hostVersion:
            typeof payload.cli_version === "string"
              ? payload.cli_version
              : undefined,
          entrypoint:
            typeof payload.originator === "string"
              ? payload.originator
              : undefined,
        };
      }
      if (host === "claude-code" && typeof record.sessionId === "string") {
        return {
          sessionId: record.sessionId,
          cwd: typeof record.cwd === "string" ? record.cwd : undefined,
          gitBranch:
            typeof record.gitBranch === "string" ? record.gitBranch : undefined,
          hostVersion:
            typeof record.version === "string" ? record.version : undefined,
          entrypoint:
            typeof record.entrypoint === "string"
              ? record.entrypoint
              : undefined,
        };
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

interface TurnBoundary {
  nativeTurnKey: string;
  byteOffset: number;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function lifecycleBoundary(
  host: CaptureHost,
  line: Buffer,
  byteOffset: number,
): TurnBoundary | undefined {
  try {
    const value: unknown = JSON.parse(line.toString("utf8"));
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    if (host === "codex") {
      if (record.type !== "turn_context") return undefined;
      const payload =
        typeof record.payload === "object" && record.payload !== null
          ? (record.payload as Record<string, unknown>)
          : undefined;
      const turnId = string(payload?.turn_id);
      return turnId ? { nativeTurnKey: turnId, byteOffset } : undefined;
    }
    if (
      record.type !== "user" ||
      record.isMeta === true ||
      record.isSidechain === true
    ) {
      return undefined;
    }
    const message =
      typeof record.message === "object" && record.message !== null
        ? (record.message as Record<string, unknown>)
        : undefined;
    const content = message?.content;
    if (
      Array.isArray(content) &&
      content.length > 0 &&
      content.every(
        (part) =>
          typeof part === "object" &&
          part !== null &&
          (part as Record<string, unknown>).type === "tool_result",
      )
    ) {
      return undefined;
    }
    const uuid = string(record.uuid);
    return uuid ? { nativeTurnKey: uuid, byteOffset } : undefined;
  } catch {
    return undefined;
  }
}

async function currentTurnBoundary(
  host: CaptureHost,
  path: string,
  expectedTurnId?: string,
): Promise<TurnBoundary | undefined> {
  let handle;
  try {
    const size = (await stat(path)).size;
    handle = await open(path, "r");
    let window = Math.min(size, 64 * 1024);
    while (window > 0) {
      const start = size - window;
      const content = Buffer.alloc(window);
      await handle.read(content, 0, window, start);
      const boundaries: TurnBoundary[] = [];
      let lineStart = start === 0 ? 0 : content.indexOf(0x0a) + 1;
      while (lineStart > 0 || start === 0) {
        const newline = content.indexOf(0x0a, lineStart);
        if (newline < 0) break;
        const boundary = lifecycleBoundary(
          host,
          content.subarray(lineStart, newline),
          start + lineStart,
        );
        if (boundary) boundaries.push(boundary);
        lineStart = newline + 1;
      }
      const latest = boundaries.at(-1);
      if (latest) {
        if (expectedTurnId && latest.nativeTurnKey !== expectedTurnId) {
          return undefined;
        }
        if (host === "claude-code") return latest;
        let first = latest;
        let prior = false;
        for (let index = boundaries.length - 2; index >= 0; index -= 1) {
          const candidate = boundaries[index]!;
          if (candidate.nativeTurnKey !== latest.nativeTurnKey) {
            prior = true;
            break;
          }
          first = candidate;
        }
        if (prior || start === 0) return first;
      }
      if (start === 0) return undefined;
      window = Math.min(size, window * 2);
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function markerFor(
  host: CaptureHost,
  sessionId: string,
  sourcePath: string,
  home: string,
): Promise<CaptureActivationMarker | undefined> {
  try {
    const canonicalPath = await realpath(sourcePath);
    const info = await stat(canonicalPath);
    const sourceIdentity = transcriptIdentity(canonicalPath);
    const value: unknown = JSON.parse(
      await readFile(
        captureActivationPath(host, sessionId, sourceIdentity, home),
        "utf8",
      ),
    );
    if (typeof value !== "object" || value === null) return undefined;
    const marker = value as CaptureActivationMarker;
    return marker.version === CAPTURE_ACTIVATION_VERSION &&
      marker.host === host &&
      marker.sessionId === sessionId &&
      marker.transcriptIdentity === sourceIdentity &&
      marker.device === String(info.dev) &&
      marker.inode === String(info.ino) &&
      typeof marker.nativeTurnKey === "string" &&
      Number.isSafeInteger(marker.byteOffset) &&
      marker.byteOffset >= 0
      ? marker
      : undefined;
  } catch {
    return undefined;
  }
}

export async function readCaptureActivation(
  host: CaptureHost,
  sessionId: string,
  transcriptPath: string,
  home: string = homedir(),
): Promise<CaptureActivationMarker | undefined> {
  return markerFor(host, sessionId, transcriptPath, home);
}

/** Bind a loader request to the exact source named by an authoritative hook. */
export async function materializeCaptureActivation(options: {
  host: CaptureHost;
  sessionId: string;
  transcriptPath: string;
  turnId?: string;
  home?: string;
}): Promise<CaptureActivationResult> {
  const home = options.home ?? homedir();
  const config = await resolveTelemetryConfig(home);
  if (!config.enabled) {
    await clearCaptureActivationRequest(options.host, options.sessionId, home);
    return { outcome: "no-consent" };
  }
  if (!coversHost(config, options.host)) {
    await clearCaptureActivationRequest(options.host, options.sessionId, home);
    return { outcome: "host-not-covered" };
  }
  const existing = await markerFor(
    options.host,
    options.sessionId,
    options.transcriptPath,
    home,
  );
  if (existing) return { outcome: "activated", marker: existing };
  if (!(await readRequest(options.host, options.sessionId, home))) {
    return { outcome: "request-missing" };
  }
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(options.transcriptPath);
  } catch {
    return { outcome: "source-invalid" };
  }
  const metadata = await sourceMetadata(options.host, canonicalPath);
  if (metadata?.sessionId !== options.sessionId) {
    return { outcome: "source-invalid", detail: "session id mismatch" };
  }
  const boundary = await currentTurnBoundary(
    options.host,
    canonicalPath,
    options.turnId,
  );
  if (!boundary) {
    return { outcome: "source-invalid", detail: "turn boundary mismatch" };
  }
  try {
    const info = await stat(canonicalPath);
    const sourceIdentity = transcriptIdentity(canonicalPath);
    const marker: CaptureActivationMarker = {
      version: CAPTURE_ACTIVATION_VERSION,
      host: options.host,
      sessionId: options.sessionId,
      transcriptIdentity: sourceIdentity,
      nativeTurnKey: boundary.nativeTurnKey,
      byteOffset: boundary.byteOffset,
      device: String(info.dev),
      inode: String(info.ino),
      cwd: metadata.cwd,
      gitBranch: metadata.gitBranch,
      hostVersion: metadata.hostVersion,
      entrypoint: metadata.entrypoint,
      activatedAt: new Date().toISOString(),
    };
    await writePrivateJson(
      captureActivationPath(
        options.host,
        options.sessionId,
        sourceIdentity,
        home,
      ),
      marker,
    );
    await clearCaptureActivationRequest(options.host, options.sessionId, home);
    return { outcome: "activated", marker };
  } catch (error) {
    return {
      outcome: "marker-write-failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
