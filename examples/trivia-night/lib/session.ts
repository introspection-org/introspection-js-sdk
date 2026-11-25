/**
 * Sign-in for the page: the platform's hosted login for a `spa` application
 * (authorization code + PKCE), exchanged on this server, which keeps the
 * signed-in member in an httpOnly cookie sealed with AES-256-GCM under
 * TRIVIA_SESSION_SECRET, so any instance of the page can read it and none
 * holds it. The browser never holds a platform token, and trials still run
 * with the agent key. Server only.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import {
  authorizationCodeToken,
  type OAuthToken,
} from "@introspection-sdk/introspection-node";
import { decodeJwt } from "jose";

import { platformClient, resolveTarget, type Env } from "./platform-runner";

export const SESSION_COOKIE = "trivia_session";
export const LOGIN_COOKIE = "trivia_login";
/** The page makes no platform call with the token, so it asks for the least. */
const LOGIN_SCOPE = "tasks:read";
const MIN_SECRET_LENGTH = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Bound into every sealed value, so a value sealed for another purpose never opens as a session. */
const SEAL_AAD = Buffer.from("trivia-night/session/v1");

export interface Session {
  member_id: string;
  org_id: string;
  project_id: string;
  expires_at: number;
}

export class LoginRefused extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
  }
}

const store = globalThis as unknown as {
  __triviaKeyProject?: { runtime: string; project: string };
};

export function spaClientId(env: Env = process.env): string {
  return env.TRIVIA_SPA_CLIENT_ID?.trim() ?? "";
}

/** The sealing key, from TRIVIA_SESSION_SECRET, or why there is none. */
export function sessionKey(
  env: Env = process.env,
): { key: Buffer } | { missing: string } {
  const secret = env.TRIVIA_SESSION_SECRET?.trim() ?? "";
  if (secret.length < MIN_SECRET_LENGTH)
    return {
      missing: `TRIVIA_SESSION_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters (openssl rand -base64 32)`,
    };
  return { key: createHash("sha256").update(secret).digest() };
}

export function sealSession(session: Session, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(SEAL_AAD);
  const sealed = Buffer.concat([
    cipher.update(JSON.stringify(session), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString("base64url");
}

/** The session a sealed value holds, or null when it was not sealed with `key` or is malformed. */
export function openSession(value: string, key: Buffer): Session | null {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length <= IV_BYTES + TAG_BYTES) return null;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    bytes.subarray(0, IV_BYTES),
  );
  decipher.setAAD(SEAL_AAD);
  decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
  let plain: string;
  try {
    plain = Buffer.concat([
      decipher.update(bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // A forged, tampered or rotated-out cookie: no session.
    return null;
  }
  const parsed = JSON.parse(plain) as Partial<Session>;
  if (
    typeof parsed.member_id !== "string" ||
    typeof parsed.org_id !== "string" ||
    typeof parsed.project_id !== "string" ||
    typeof parsed.expires_at !== "number"
  )
    return null;
  return parsed as Session;
}

/** The project the agent key runs trials in: its runtime's, read with the key. */
export async function keyProject(): Promise<string> {
  const target = await resolveTarget();
  if (store.__triviaKeyProject?.runtime === target.runtime)
    return store.__triviaKeyProject.project;
  const { project_id } = await platformClient().runtimes.get(target.runtime);
  store.__triviaKeyProject = { runtime: target.runtime, project: project_id };
  return project_id;
}

/** The hosted-login redirect, and the PKCE verifier and state to keep for the callback. */
export function loginRequest(
  clientId: string,
  project: string,
  redirectUri: string,
  cpUrl: string,
): { url: string; cookie: string } {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    scope: LOGIN_SCOPE,
    project,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  return {
    url: `${cpUrl.replace(/\/+$/, "")}/v1/oauth/authorize?${params}`,
    cookie: JSON.stringify({ verifier, state }),
  };
}

export interface Callback {
  code: string | null;
  state: string | null;
  /** The login cookie `loginRequest` set. */
  cookie: string | undefined;
  redirectUri: string;
  clientId: string;
  cpUrl: string;
  /** The project the agent key runs in; the member must be signed in to it. */
  project: () => Promise<string>;
  key: Buffer;
}

/**
 * Exchanges the code with the Control Plane, over this server's own PKCE
 * verifier, and seals a session for the member it signed in.
 */
export async function completeLogin(
  callback: Callback,
  now = Date.now(),
): Promise<{ cookie: string; session: Session }> {
  const flow = callback.cookie
    ? (JSON.parse(callback.cookie) as { verifier?: string; state?: string })
    : {};
  if (!callback.code || !flow.verifier || callback.state !== flow.state)
    throw new LoginRefused("the sign-in did not match this browser", 401);
  const token = await authorizationCodeToken({
    code: callback.code,
    clientId: callback.clientId,
    redirectUri: callback.redirectUri,
    codeVerifier: flow.verifier,
    baseApiUrl: callback.cpUrl,
  });
  return sessionFromToken(token, callback, now);
}

/**
 * The session a token from that exchange opens, only in the agent key's
 * project. The token comes straight from the Control Plane in reply to the
 * exchange, so its claims are read as issued.
 */
export async function sessionFromToken(
  token: OAuthToken,
  callback: Pick<Callback, "project" | "key">,
  now = Date.now(),
): Promise<{ cookie: string; session: Session }> {
  const claims = decodeJwt(token.access_token);
  const member = claims.member_id;
  const project = claims.project_id;
  const org = claims.org_id;
  if (typeof member !== "string" || typeof org !== "string")
    throw new LoginRefused("the sign-in named no member", 401);
  if (project !== (await callback.project()))
    throw new LoginRefused(
      "you signed in to a different project from the one this page runs trials in",
      403,
    );
  const session: Session = {
    member_id: member,
    org_id: org,
    project_id: project,
    expires_at: now + token.expires_in * 1000,
  };
  return { cookie: sealSession(session, callback.key), session };
}

/** The live session a sealed cookie value holds, or null. */
export function sessionFor(
  value: string | undefined,
  now = Date.now(),
  env: Env = process.env,
): Session | null {
  const sealing = sessionKey(env);
  if (!value || "missing" in sealing) return null;
  const session = openSession(value, sealing.key);
  return session && session.expires_at > now ? session : null;
}

/** What a route may act for: a live session in the agent key's project, or why not. */
export async function requireSession(
  request: Request,
  project: () => Promise<string> = keyProject,
): Promise<{ session: Session } | { status: 401 | 403 | 503; error: string }> {
  const session = sessionFor(sessionCookie(request));
  if (!session) return { status: 401, error: "sign in first" };
  let expected: string;
  try {
    expected = await project();
  } catch (error) {
    return {
      status: 503,
      error: `could not read the agent key's project: ${(error as Error).message}`,
    };
  }
  if (session.project_id !== expected)
    return {
      status: 403,
      error: "your sign-in is not for this page's project",
    };
  return { session };
}

/** The sealed session a request's cookie carries. */
export function sessionCookie(request: Request): string | undefined {
  for (const part of request.headers.get("cookie")?.split(";") ?? []) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=");
  }
  return undefined;
}
