/**
 * Shared Introspection sample helpers — the config consts, PKCE utilities, and
 * the common "redeem an Introspection token → DP session cookie → create + stream
 * a task" tail used by every auth mode page (/jwks, /spa,
 * /service-account).
 */
export const CP_URL = (
  process.env.NEXT_PUBLIC_INTROSPECTION_CP_URL ?? "http://localhost:8000"
).replace(/\/+$/, "");
export const DP_URL = (
  process.env.NEXT_PUBLIC_INTROSPECTION_DP_URL ?? "http://localhost:8002"
).replace(/\/+$/, "");
export const PROJECT_ID =
  process.env.NEXT_PUBLIC_INTROSPECTION_PROJECT_ID ?? "";
export const SPA_CLIENT_ID =
  process.env.NEXT_PUBLIC_INTROSPECTION_SPA_CLIENT_ID ?? "";
export const RUNTIME_ID =
  process.env.NEXT_PUBLIC_INTROSPECTION_RUNTIME_ID ?? "";
export const FALLBACK_AGENT_NAME = "customer-agent";

/**
 * The application type the seed federated this IdP into (matches the CP
 * `application_type`), which determines how the subject_token is verified
 * (applications-and-oauth.md §5.0★ / §5.0★★). A
 * `jwks` application (the default) signs in at the partner IdP (Supabase)
 * headlessly and presents its session access token directly — NO Zitadel
 * redirect, NO consent page. An `spa` application keeps the as-built brokered
 * redirect flow (customers-org login → id_token). The CP derives the
 * verification path from the application type.
 */
export type ApplicationType = "jwks" | "spa";
export const APPLICATION_TYPE: ApplicationType =
  process.env.NEXT_PUBLIC_APPLICATION_TYPE === "spa" ? "spa" : "jwks";

/**
 * Federated brokered-IdP display/config the browser needs. The label
 * (`okta` | `supabase` | `auth0` | `neon` | `generic`) and issuer/client_id
 * describe the customer's OWN IdP — swapping vendors is purely these three
 * values, no code change. The `client_secret` for the IdP lives only in
 * Introspection's `application_idps` join, never here. Note `neon` has no
 * headless browser sign-in (lib/supabase.ts is Supabase-specific): in neon
 * mode the user pastes a Neon Auth JWT as the subject_token (see README).
 */
export type IdpProvider = "okta" | "supabase" | "auth0" | "neon" | "generic";
const IDP_PROVIDER_RAW = process.env.NEXT_PUBLIC_IDP_PROVIDER ?? "generic";
export const IDP_PROVIDER: IdpProvider = (
  ["okta", "supabase", "auth0", "neon", "generic"] as const
).includes(IDP_PROVIDER_RAW as IdpProvider)
  ? (IDP_PROVIDER_RAW as IdpProvider)
  : "generic";
export const IDP_ISSUER = process.env.NEXT_PUBLIC_IDP_ISSUER ?? "";
export const IDP_CLIENT_ID = process.env.NEXT_PUBLIC_IDP_CLIENT_ID ?? "";
export const ZITADEL_ISSUER_URL = (
  process.env.NEXT_PUBLIC_ZITADEL_ISSUER_URL ?? "http://localhost:8009"
).replace(/\/+$/, "");
export const BROKERED_EXTERNAL_ORG_ID =
  process.env.NEXT_PUBLIC_BROKERED_EXTERNAL_ORG_ID ?? "";
export const BROKERED_AUDIENCE_CLIENT_ID =
  process.env.NEXT_PUBLIC_BROKERED_AUDIENCE_CLIENT_ID ?? "";

/** Human label for the brokered IdP vendor, for the federated UI. */
export const IDP_PROVIDER_LABEL: Record<IdpProvider, string> = {
  okta: "Okta",
  supabase: "Supabase",
  auth0: "Auth0",
  neon: "Neon Auth",
  generic: "Generic OIDC",
};

export type LogKind = "info" | "ok" | "err";
export interface LogLine {
  kind: LogKind;
  text: string;
}
export type Append = (kind: LogKind, text: string) => void;

export function wsUrlFor(dpUrl: string): string {
  return dpUrl.replace(/^http/, "ws");
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** RFC 7636 PKCE pair (S256). */
export async function generatePkce(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

const SUBJECT_TOKEN_TYPE_ID_TOKEN = "urn:ietf:params:oauth:token-type:id_token";
const GRANT_TYPE_TOKEN_EXCHANGE =
  "urn:ietf:params:oauth:grant-type:token-exchange";

export interface TokenExchangeRequest {
  cpUrl: string;
  clientId: string;
  projectId: string;
  /** The end user's id_token from the customer's OWN (brokered) IdP. */
  subjectToken: string;
  scope?: string;
}

/**
 * RFC 8693 token-exchange against CP `/v1/oauth/token`: trade the end user's
 * brokered-IdP id_token for a project-scoped DP access token for a
 * `member_type=customer` member. Same form-encoded fetch + error style as the
 * spa `authorization_code` token call; intended to run server-side in the
 * broker (the id_token shouldn't be re-handled in the browser any longer than
 * needed). Returns the `access_token`.
 */
export async function tokenExchange(
  req: TokenExchangeRequest,
): Promise<string> {
  const form = new URLSearchParams({
    grant_type: GRANT_TYPE_TOKEN_EXCHANGE,
    subject_token: req.subjectToken,
    subject_token_type: SUBJECT_TOKEN_TYPE_ID_TOKEN,
    client_id: req.clientId,
    project_id: req.projectId,
  });
  if (req.scope) form.set("scope", req.scope);

  const res = await fetch(`${req.cpUrl}/v1/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(
      `token-exchange returned ${res.status}: ${detail.slice(0, 500)}`,
    );
  }
  const { access_token } = (await res.json()) as { access_token: string };
  return access_token;
}

/**
 * `service_account`: the broker mints a machine token via client_credentials.
 * `federated`: the broker runs the RFC 8693 token-exchange grant on the given
 * partner-IdP `subject_token`. Either way the secret/token stays server-side
 * and the broker returns the Introspection access_token.
 */
export async function brokerSession(
  mode: "service_account" | "federated",
  subjectToken?: string,
): Promise<{ token: string; projectId: string }> {
  const res = await fetch("/api/broker/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      mode === "federated" ? { mode, subject_token: subjectToken } : { mode },
    ),
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: "" }));
    throw new Error(error || `broker returned ${res.status}`);
  }
  return (await res.json()) as { token: string; projectId: string };
}

/**
 * Redeem an Introspection token at the DP for the HttpOnly `intro_dp_session`
 * cookie. After this the browser talks to the DP directly — no token in JS.
 */
export async function exchangeDpSession(opts: {
  token: string;
  projectId: string;
  append: Append;
}): Promise<void> {
  const { token, projectId, append } = opts;
  append("info", "Exchanging for a Data Plane session cookie …");
  const exchangeRes = await fetch(`${DP_URL}/v1/oauth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, project_id: projectId }),
    credentials: "include",
  });
  if (!exchangeRes.ok) {
    throw new Error(`DP exchange returned ${exchangeRes.status}`);
  }
  append("ok", "   ✓ intro_dp_session cookie set");
}

/**
 * Caller identity for attribution (#823): rides `metadata.identity` on the
 * task create. For machine (client_credentials) tokens — which carry no
 * identity claim of their own — the DP persists this onto the task, and the
 * platform mints the attribution-rung MCP assertion from it
 * (`sub: user:{user_id}`, `type: "identity_attribution"`).
 */
export interface TaskIdentity {
  user_id?: string;
  anonymous_id?: string;
  conversation_id?: string;
}

/**
 * The tail shared by all modes: redeem the Introspection token at the DP for a
 * session cookie, create a task (pinned to a runtime when configured), and open
 * the event stream. Returns the WebSocket so the caller can close it.
 */
export async function runTaskWithToken(opts: {
  token: string;
  projectId: string;
  prompt: string;
  append: Append;
  /** Optional caller identity, stamped onto `metadata.identity` (#823). */
  identity?: TaskIdentity;
}): Promise<WebSocket> {
  const { token, projectId, prompt, append, identity } = opts;

  await exchangeDpSession({ token, projectId, append });

  append(
    "info",
    RUNTIME_ID
      ? `Creating a task for runtime ${RUNTIME_ID.slice(0, 8)}… …`
      : `Creating a "${FALLBACK_AGENT_NAME}" task …`,
  );
  const metadata = identity ? { metadata: { identity } } : {};
  const taskRes = await fetch(`${DP_URL}/v1/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      RUNTIME_ID
        ? { prompt, runtime_id: RUNTIME_ID, ...metadata }
        : { prompt, agent_name: FALLBACK_AGENT_NAME, ...metadata },
    ),
    credentials: "include",
  });
  if (!taskRes.ok) throw new Error(`task create returned ${taskRes.status}`);
  const task = (await taskRes.json()) as { task_id?: string; id?: string };
  append("ok", `   ✓ task ${task.task_id ?? task.id ?? "(?)"} created`);

  append("info", "Streaming task events …");
  const socket = new WebSocket(`${wsUrlFor(DP_URL)}/v1/ws/stream`);
  socket.onopen = () => append("ok", "   ✓ stream connected");
  socket.onmessage = (event) => append("info", `   ◂ ${event.data}`);
  socket.onerror = () => append("err", "   ✗ stream error");
  socket.onclose = (event) =>
    append(
      event.code === 1000 ? "info" : "err",
      `   stream closed (${event.code}${event.reason ? `: ${event.reason}` : ""})`,
    );
  return socket;
}
