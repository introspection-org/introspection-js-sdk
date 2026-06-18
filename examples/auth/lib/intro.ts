/**
 * Shared Introspection sample helpers — the config consts, PKCE utilities, and
 * the common "redeem an Introspection token → DP session cookie → create + stream
 * a task → verify it was logged" tail used by every auth mode page (/jwks, /spa,
 * /service-account).
 *
 * The DP-facing tail (`runTaskWithToken`) is driven entirely by the browser
 * SDK's {@link IntrospectionApiClient} — no hand-rolled `/v1/oauth/exchange`,
 * `/v1/tasks`, or WebSocket plumbing in the app.
 */
import {
  IntrospectionApiClient,
  type SseEvent,
} from "@introspection-sdk/introspection-browser/api";

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
 * The application type this IdP is federated into (matches the CP
 * `application_type`), which determines how the subject_token is verified. A
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
 * Caller identity for attribution: rides `metadata.identity` on the
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

/** A live run the caller can tear down (stops streaming + any pending poll). */
export interface RunSession {
  close: () => void;
}

const CONVERSATION_POLL_INTERVAL_MS = 5_000;
const CONVERSATION_POLL_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatEvent(ev: SseEvent): string {
  const data = ev.data.length > 200 ? `${ev.data.slice(0, 200)}…` : ev.data;
  return `${ev.event}: ${data}`;
}

/**
 * After the task stream completes, confirm the run actually landed in the
 * telemetry store by polling the read-only `/v1/conversations` projection
 * with the SAME identity session. Telemetry is batched, so a fresh
 * conversation can take ~10–30s to appear — we poll rather than assume.
 * `seen` is the set of conversation ids that already existed before the run,
 * so we report only the new one this task produced.
 */
async function verifyConversationLogged(opts: {
  client: IntrospectionApiClient;
  append: Append;
  seen: Set<string>;
  isCancelled: () => boolean;
}): Promise<void> {
  const { client, append, seen, isCancelled } = opts;
  append(
    "info",
    "Verifying the run was logged — querying /v1/conversations (telemetry is batched, ~10–30s) …",
  );
  const deadline = Date.now() + CONVERSATION_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(CONVERSATION_POLL_INTERVAL_MS);
    if (isCancelled()) return;
    let records;
    try {
      records = (await client.conversations.list({ limit: 50 })).records;
    } catch (err) {
      append(
        "err",
        `   ✗ conversations query failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const fresh = records.find(
      (c) =>
        typeof c.conversation_id === "string" && !seen.has(c.conversation_id),
    );
    if (fresh?.conversation_id) {
      const conversationId = fresh.conversation_id;
      append("ok", `   ✓ conversation logged: ${conversationId}`);
      try {
        const turn = await client.conversations.retrieve(conversationId);
        if (turn) {
          append(
            "info",
            `   ◂ latest turn — model=${turn.model ?? "?"}, ${turn.output_messages.length} output message(s)`,
          );
        }
      } catch {
        // retrieve() is a best-effort detail read; the list hit is the proof.
      }
      return;
    }
    append("info", "   … not visible yet, retrying …");
  }
  append(
    "err",
    "   ✗ no new conversation within 30s — telemetry may still be batching; re-query /v1/conversations shortly.",
  );
}

/**
 * The tail shared by all modes, driven by the browser SDK: build an
 * {@link IntrospectionApiClient}, `connect()` for the `intro_dp_session`
 * cookie, `tasks.start(...)` a run, stream its events, then verify the run
 * was logged via `/v1/conversations`. Returns a {@link RunSession} the caller
 * can `close()` to stop streaming.
 *
 * The Introspection token is handled only to seed `getToken`; every DP call
 * after `connect()` rides the HttpOnly cookie.
 */
export async function runTaskWithToken(opts: {
  token: string;
  projectId: string;
  prompt: string;
  append: Append;
  /** Optional caller identity, folded into `metadata.identity`. */
  identity?: TaskIdentity;
}): Promise<RunSession> {
  const { token, projectId, prompt, append, identity } = opts;

  const client = new IntrospectionApiClient({
    dpUrl: DP_URL,
    projectId,
    getToken: () => token,
  });

  append("info", "Exchanging for a Data Plane session cookie …");
  await client.connect();
  append("ok", "   ✓ intro_dp_session cookie set");

  // Snapshot the identity's existing conversations so we can single out the
  // new one this task produces once telemetry lands. Conversations are
  // addressed by the gen_ai `conversation_id` (the `/v1/conversations/{id}`
  // path key) — never the raw trace id.
  const seen = new Set(
    (await client.conversations.list({ limit: 50 })).records
      .map((c) => c.conversation_id)
      .filter((id): id is string => typeof id === "string"),
  );

  append(
    "info",
    RUNTIME_ID
      ? `Creating a task for runtime ${RUNTIME_ID.slice(0, 8)}… …`
      : `Creating a "${FALLBACK_AGENT_NAME}" task …`,
  );
  const run = await client.tasks.start({
    prompt,
    ...(RUNTIME_ID
      ? { runtime_id: RUNTIME_ID }
      : { agent_name: FALLBACK_AGENT_NAME }),
    ...(identity ? { identity } : {}),
  });
  append("ok", `   ✓ task ${run.task?.id ?? run.run.task_id} created`);

  let cancelled = false;

  // Stream events, then verify logging — in the background so the caller gets
  // a teardown handle immediately.
  void (async () => {
    append("info", "Streaming task events …");
    try {
      for await (const ev of run.stream()) {
        if (cancelled) return;
        append("info", `   ◂ ${formatEvent(ev)}`);
      }
      append("ok", "   ✓ stream complete");
    } catch (err) {
      if (!cancelled) {
        append(
          "err",
          `   ✗ stream error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }
    if (!cancelled) {
      await verifyConversationLogged({
        client,
        append,
        seen,
        isCancelled: () => cancelled,
      });
    }
  })();

  return {
    close: () => {
      cancelled = true;
    },
  };
}
