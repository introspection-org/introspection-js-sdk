/**
 * Sign-in for the page: the platform's hosted login for a `spa` application
 * (authorization code + PKCE), exchanged on this server, which keeps the
 * signed-in member as an opaque session behind an httpOnly cookie. The browser
 * never holds a platform token, and trials still run with the agent key.
 * Server only.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  IntrospectionClient,
  authorizationCodeToken,
} from "@introspection-sdk/introspection-node";
import { decodeJwt } from "jose";

import { apiBaseUrl, keyFile, resolveTarget } from "./platform-runner";

export const SESSION_COOKIE = "trivia_session";
export const LOGIN_COOKIE = "trivia_login";
/** The page makes no platform call with the token, so it asks for the least. */
const LOGIN_SCOPE = "tasks:read";

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
  __triviaSignIns?: Map<string, Session>;
  __triviaKeyProject?: { file: string; project: string };
};
const sessions = (store.__triviaSignIns ??= new Map());

export function spaClientId(env: NodeJS.ProcessEnv = process.env): string {
  return env.TRIVIA_SPA_CLIENT_ID?.trim() ?? "";
}

/** The project the agent key runs trials in: its runtime's, read with the key. */
export async function keyProject(): Promise<string> {
  const found = keyFile();
  if ("missing" in found) throw new Error(found.missing);
  if (store.__triviaKeyProject?.file === found.file)
    return store.__triviaKeyProject.project;
  const target = await resolveTarget({
    ...process.env,
    INTROSPECTION_API_BASE_URL: apiBaseUrl(),
  });
  const client = new IntrospectionClient({
    token: readFileSync(found.file, "utf8").trim(),
    advanced: { baseApiUrl: apiBaseUrl() },
  });
  const { project_id } = await client.runtimes.get(target.runtime);
  store.__triviaKeyProject = { file: found.file, project: project_id };
  return project_id;
}

/** The hosted-login redirect, and the PKCE verifier and state to keep for the callback. */
export function loginRequest(
  clientId: string,
  project: string,
  redirectUri: string,
  cpUrl: string = apiBaseUrl(),
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
  /** The project the agent key runs in; the member must be signed in to it. */
  project: () => Promise<string>;
}

/**
 * Exchanges the code and opens a session for the member it signed in, only in
 * the agent key's project. The token comes straight from the Control Plane in
 * reply to this server's own PKCE exchange, so its claims are read as issued.
 */
export async function completeLogin(
  callback: Callback,
  exchange: typeof authorizationCodeToken = authorizationCodeToken,
  now = Date.now(),
): Promise<{ id: string; session: Session }> {
  const flow = callback.cookie
    ? (JSON.parse(callback.cookie) as { verifier?: string; state?: string })
    : {};
  if (!callback.code || !flow.verifier || callback.state !== flow.state)
    throw new LoginRefused("the sign-in did not match this browser", 401);
  const token = await exchange({
    code: callback.code,
    clientId: callback.clientId,
    redirectUri: callback.redirectUri,
    codeVerifier: flow.verifier,
    baseApiUrl: apiBaseUrl(),
  });
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
  const id = randomBytes(32).toString("base64url");
  sessions.set(id, session);
  return { id, session };
}

/** The live session a cookie names, or null. */
export function sessionFor(
  id: string | undefined,
  now = Date.now(),
): Session | null {
  const session = id ? sessions.get(id) : undefined;
  if (!session) return null;
  if (session.expires_at > now) return session;
  sessions.delete(id!);
  return null;
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

/** The session id a request's cookie carries. */
export function sessionCookie(request: Request): string | undefined {
  for (const part of request.headers.get("cookie")?.split(";") ?? []) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=");
  }
  return undefined;
}
