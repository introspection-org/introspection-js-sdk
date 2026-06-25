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
  EventType,
  IntrospectionApiClient,
  type AGUIEvent,
} from "@introspection-sdk/introspection-browser/api";

export const CP_URL = (
  process.env.NEXT_PUBLIC_INTROSPECTION_CP_URL ?? "http://localhost:8000"
).replace(/\/+$/, "");
export const PROJECT = process.env.NEXT_PUBLIC_INTROSPECTION_PROJECT ?? "";
export const SPA_CLIENT_ID =
  process.env.NEXT_PUBLIC_INTROSPECTION_SPA_CLIENT_ID ?? "";

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

/**
 * The session the broker establishes server-side and hands back. Everything
 * the browser needs to run a task — and nothing more: the access token, the
 * project, the server-resolved `runtimeId`, and the DP URL from the CP token
 * response. No CP/DP/runtime config lives in the browser.
 */
export interface BrokerSession {
  token: string;
  project: string;
  runtimeId: string;
  dpUrl: string;
}

/**
 * Payload for {@link brokerSession}, one variant per grant the broker runs
 * through the Node SDK (`serviceAccountToken` / `tokenExchange` /
 * `authorizationCodeToken`).
 */
export type BrokerRequest =
  | { mode: "service_account" }
  | { mode: "federated"; subject_token: string }
  | {
      mode: "authorization_code";
      code: string;
      code_verifier: string;
      redirect_uri: string;
    };

/**
 * Call the app's own broker (`/api/broker/session`). The broker runs the
 * Introspection token POST server-side via the Node SDK, resolves the runtime
 * id, and reads the DP URL off the CP response — so every mode returns the same
 * {@link BrokerSession} and the browser issues no Introspection OAuth calls.
 */
export async function brokerSession(
  req: BrokerRequest,
): Promise<BrokerSession> {
  const res = await fetch("/api/broker/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: "" }));
    throw new Error(error || `broker returned ${res.status}`);
  }
  return (await res.json()) as BrokerSession;
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

function truncate(value: string): string {
  return value.length > 200 ? `${value.slice(0, 200)}...` : value;
}

function formatEvent(ev: AGUIEvent): string {
  switch (ev.type) {
    case EventType.TEXT_MESSAGE_CONTENT:
    case EventType.TEXT_MESSAGE_CHUNK:
      return `${ev.type}: ${truncate(ev.delta ?? "")}`;
    case EventType.TOOL_CALL_RESULT:
      return `${ev.type}: ${truncate(ev.content)}`;
    case EventType.RUN_ERROR:
      return `${ev.type}: ${truncate(ev.message)}`;
    default:
      return ev.type;
  }
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
export async function runTaskWithToken(
  /** DP base URL the CP returned to the broker — the single source for it. */
  dpUrl: string,
  opts: {
    token: string;
    prompt: string;
    append: Append;
    /** Server-resolved runtime id; pins the task via `runtime_id`. */
    runtimeId: string;
    /** Optional caller identity, folded into `metadata.identity`. */
    identity?: TaskIdentity;
  },
): Promise<RunSession> {
  const { token, prompt, append, runtimeId, identity } = opts;

  // The session's project is derived from the token's claims at exchange —
  // the client takes no project selector. The DP URL came from the CP token response
  // (via the broker), so the browser is configured entirely from the server.
  const client = new IntrospectionApiClient({
    dpUrl,
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

  append("info", `Creating a task for runtime ${runtimeId.slice(0, 8)}… …`);
  const run = await client.tasks.start({
    prompt,
    runtime_id: runtimeId,
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
