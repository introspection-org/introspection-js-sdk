/**
 * The page's sign-in, all in the browser: the platform's hosted login for a
 * `spa` application (authorization code + PKCE), the code exchanged at the
 * Control Plane's token endpoint, and the token redeemed at the Data Plane for
 * its session cookie, which every trial call then rides. The token sits in
 * sessionStorage until it expires, and the page signs in again after that.
 */
import { IntrospectionApiClient } from "@introspection-sdk/introspection-browser/api";

import type { Target } from "./platform-evals";

/** Public configuration, inlined at build time. */
export const CONFIG = {
  cpUrl:
    process.env.NEXT_PUBLIC_INTROSPECTION_API_BASE_URL ||
    "https://api.introspection.dev",
  dpUrl:
    process.env.NEXT_PUBLIC_INTROSPECTION_DP_URL ||
    process.env.NEXT_PUBLIC_INTROSPECTION_API_BASE_URL ||
    "https://api.introspection.dev",
  clientId: process.env.NEXT_PUBLIC_TRIVIA_SPA_CLIENT_ID ?? "",
  runtime: process.env.NEXT_PUBLIC_INTROSPECTION_TRIVIA_RUNTIME_ID ?? "",
  repository: process.env.NEXT_PUBLIC_INTROSPECTION_TRIVIA_REPOSITORY_ID ?? "",
  commit: process.env.NEXT_PUBLIC_INTROSPECTION_TRIVIA_COMMIT_SHA ?? "",
  recipePath: process.env.NEXT_PUBLIC_INTROSPECTION_TRIVIA_RECIPE_PATH ?? "",
};

/** The configured Runtime, or null when the page names none. */
export function configuredTarget(config = CONFIG): Target | null {
  if (!config.runtime || !config.repository || !config.commit) return null;
  return {
    runtime: config.runtime,
    commit: config.commit,
    repository: config.repository,
    recipe_path: config.recipePath,
  };
}

/**
 * What a run calls, and no more: the trials (`tasks:*`, with `tasks:eval` and
 * `tasks:exec` for a verified eval task), their archives and results
 * (`files:*`), and the repository and sidecar image (`*:read`).
 */
export const LOGIN_SCOPES = [
  "tasks:read",
  "tasks:write",
  "tasks:eval",
  "tasks:exec",
  "files:read",
  "files:write",
  "repositories:read",
  "images:read",
];
/** What starting or moving a run on needs beyond reading it; an owner or admin holds them. */
export const RUN_SCOPES = [
  "tasks:write",
  "tasks:eval",
  "tasks:exec",
  "files:write",
];

export interface Session {
  access_token: string;
  member_id: string;
  project_id: string;
  scope: string[];
  expires_at: number;
  /** The lane the Data Plane set its cookie for, once the token is redeemed. */
  environment?: string;
}

const SESSION_KEY = "trivia-night:session";
const FLOW_KEY = "trivia-night:login";

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

/** The live session, or null; one that has expired is removed, so the page signs in again. */
export function storedSession(
  storage: Pick<Storage, "getItem" | "removeItem">,
  now = Date.now(),
): Session | null {
  const raw = storage.getItem(SESSION_KEY);
  const session = raw ? (JSON.parse(raw) as Session) : null;
  if (session && session.expires_at > now) return session;
  storage.removeItem(SESSION_KEY);
  return null;
}

/** The hosted-login URL; the PKCE verifier and state wait in `storage` for the callback. */
export async function loginUrl(
  storage: Pick<Storage, "setItem">,
  redirectUri: string,
  config = CONFIG,
): Promise<string> {
  const verifier = random();
  const state = random();
  storage.setItem(FLOW_KEY, JSON.stringify({ verifier, state }));
  const challenge = base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    scope: LOGIN_SCOPES.join(" "),
    // The member picks the project their trials run in.
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${config.cpUrl.replace(/\/+$/, "")}/v1/oauth/authorize?${params}`;
}

/** Exchanges the callback's code for the member's token and keeps it until it expires. */
export async function completeLogin(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  url: URL,
  fetchImpl: typeof fetch = fetch,
  config = CONFIG,
  now = Date.now(),
): Promise<Session> {
  const flow = JSON.parse(storage.getItem(FLOW_KEY) ?? "{}") as {
    verifier?: string;
    state?: string;
  };
  storage.removeItem(FLOW_KEY);
  const code = url.searchParams.get("code");
  if (!code || !flow.verifier || url.searchParams.get("state") !== flow.state)
    throw new Error("the sign-in did not match this browser");
  const response = await fetchImpl(
    `${config.cpUrl.replace(/\/+$/, "")}/v1/oauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: config.clientId,
        redirect_uri: `${url.origin}${url.pathname}`,
        code_verifier: flow.verifier,
      }),
    },
  );
  if (!response.ok)
    throw new Error(
      `the sign-in failed: ${response.status} ${await response.text()}`,
    );
  const token = (await response.json()) as {
    access_token: string;
    expires_in: number;
    scope?: string | null;
  };
  const claims = JSON.parse(
    atob(
      token.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"),
    ),
  ) as { member_id?: string; project_id?: string; scope?: string };
  if (!claims.member_id || !claims.project_id)
    throw new Error("the sign-in named no member or project");
  const session: Session = {
    access_token: token.access_token,
    member_id: claims.member_id,
    project_id: claims.project_id,
    scope: (token.scope ?? claims.scope ?? "").split(" ").filter(Boolean),
    expires_at: now + token.expires_in * 1000,
  };
  storage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

/** The scopes a session lacks of `needed`. */
export const missingScopes = (session: Session, needed: readonly string[]) =>
  needed.filter((scope) => !session.scope.includes(scope));

/**
 * A Data Plane client on the session's cookie. The token is redeemed once (the
 * exchange is single use); a reload reuses the cookie it set, in the lane it
 * named.
 */
export async function sessionClient(
  session: Session,
  storage: Pick<Storage, "setItem">,
  config = CONFIG,
): Promise<IntrospectionApiClient> {
  const client = new IntrospectionApiClient({
    dpUrl: config.dpUrl,
    getToken: () => session.access_token,
    environment: session.environment as IntrospectionApiClientEnvironment,
  });
  if (!session.environment) {
    await client.connect();
    storage.setItem(
      SESSION_KEY,
      JSON.stringify({ ...session, environment: client.environment }),
    );
  }
  return client;
}

type IntrospectionApiClientEnvironment = IntrospectionApiClient["environment"];
