/**
 * Reader for the Introspection CLI's login profile.
 *
 * The CLI's device-authorization login writes `~/.introspection/credentials.json`
 * (mode `0600`) with the project-scoped `access_token` the Data Plane accepts as
 * a bearer. Reusing it is the whole point of the integration: the plugin's spans
 * arrive under the same identity the user onboarded with, so plugin activity and
 * platform activity correlate without asking anyone to paste a second key.
 *
 * This module is read-only and deliberately narrow. It never refreshes, never
 * writes, and never logs a token value. Refresh is the CLI's job — it owns the
 * rotating refresh token and the file lock. When the access token has expired,
 * capture declines this run and waits for the next CLI invocation to refresh it;
 * the transcript offset is not advanced, so nothing is lost, it just lands on a
 * later turn.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

/** Schema version this reader understands, matching the CLI's `CREDENTIALS_VERSION`. */
export const CREDENTIALS_VERSION = 2;

/**
 * The subset of the CLI login profile this package needs.
 *
 * Intentionally omits `cp_session`, `refresh_token`, and `session_id`: capture
 * has no use for them, and a struct that cannot hold a secret cannot leak it.
 */
export interface LoginProfile {
  /** Data-Plane API base URL for the logged-in project, when resolved. */
  dpUrl?: string;
  /** Project-scoped bearer presented to the OTLP ingest endpoint. */
  accessToken: string;
  /** Absolute unix-epoch second at which `accessToken` stops being valid. */
  expiresAt: number;
  /** Space-separated scopes granted to the access token. */
  scope: string;
}

/** Path to the CLI login profile. */
export function credentialsPath(home: string = homedir()): string {
  return join(home, ".introspection", "credentials.json");
}

/**
 * Refuse a token this close to its expiry.
 *
 * Export is asynchronous and batched, so a token that is merely valid *now* can
 * still be rejected by the time the batch lands. Matching the CLI's own 60s skew
 * keeps the two components from disagreeing about whether a login is usable.
 */
export const EXPIRY_SKEW_SECONDS = 60;

function parseProfile(text: string): LoginProfile | undefined {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;

  if (obj.version !== CREDENTIALS_VERSION) return undefined;
  if (typeof obj.access_token !== "string" || obj.access_token.length === 0) {
    return undefined;
  }
  if (typeof obj.expires_at !== "number") return undefined;

  return {
    dpUrl: typeof obj.dp_url === "string" ? obj.dp_url : undefined,
    accessToken: obj.access_token,
    expiresAt: obj.expires_at,
    scope: typeof obj.scope === "string" ? obj.scope : "",
  };
}

/**
 * Load the login profile, or `undefined` when there is no usable one.
 *
 * Never throws: not-logged-in, an unreadable file, a schema bump, and a
 * malformed profile are all ordinary states on a developer's machine, and none
 * of them is worth interrupting a coding session over.
 */
export async function loadLoginProfile(
  home: string = homedir(),
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<LoginProfile | undefined> {
  let profile: LoginProfile | undefined;
  try {
    profile = parseProfile(await readFile(credentialsPath(home), "utf8"));
  } catch {
    return undefined;
  }
  if (!profile) return undefined;
  if (nowSeconds + EXPIRY_SKEW_SECONDS >= profile.expiresAt) return undefined;
  return profile;
}

/**
 * Resolve the OTLP traces endpoint for a profile.
 *
 * Prefers an explicit `INTROSPECTION_BASE_OTEL_URL`, then the login's own
 * Data-Plane host, then the public default — so a user logged into a regional or
 * self-hosted Data Plane exports to *their* Data Plane rather than silently
 * shipping to the public one.
 */
export function resolveTracesEndpoint(profile: LoginProfile): string {
  const base =
    process.env.INTROSPECTION_BASE_OTEL_URL?.trim() ||
    profile.dpUrl ||
    "https://otel.introspection.dev";
  return base.endsWith("/v1/traces")
    ? base
    : `${base.replace(/\/$/, "")}/v1/traces`;
}
