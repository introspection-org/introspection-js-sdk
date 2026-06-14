/**
 * The partner MCP server — a reference implementation of identity-assertion
 * auth (direct JWKS verification). See the MCP endpoints guide at
 * https://docs.introspection.dev.
 *
 * sample-auth plays the integration partner: this is *their* MCP server, and
 * the agent platform calls it on behalf of the federated end user. Every
 * request must carry the platform's identity-assertion JWT, which this
 * server verifies against the application's published JWKS
 * (`{CP}/v1/applications/{client_id}/.well-known/jwks.json`) — the partner-side
 * contract is exactly this file: verify signature, require our own URL as
 * `aud`, map `sub` to the user, honor `exp`.
 *
 * Two tools, a per-user key-value scratchpad: `get_value` / `set_value`.
 * The store is keyed by the VERIFIED `sub` — for a direct (jwks-app)
 * federation that is the Supabase user id the end user signed in with
 * (`sub_type: "partner"`); for spa/hosted-login members it is the
 * platform's member id (`sub_type: "member"`); for memberless
 * (service-account) tasks it is the caller-asserted identity key, e.g.
 * `user:sa-demo-user` (`sub_type: "identity"`, attribution rung). Signing
 * in as a second user provably isolates the values, and the tool responses
 * surface the assertion's `sub_type` AND `type` so demos show which
 * identity rung authenticated and at which trust level.
 * MCP_ASSERTION_JWKS_URL accepts a comma-separated list so assertions
 * signed by any linked application (jwks and spa) verify.
 *
 * This server deliberately accepts BOTH token types — the partner-side
 * opt-in the platform requires: federation-proven
 * `type: "identity_assertion"` and caller-asserted
 * `type: "identity_attribution"`. A partner that wants only
 * federation-proven subjects simply rejects the latter.
 *
 * Transport: MCP streamable HTTP (single POST endpoint, JSON-RPC 2.0,
 * stateless responses).
 *
 * Storage backends — selected PER REQUEST, from the verified assertion:
 *   - "memory" (default) — an in-memory Map keyed by the verified `sub`,
 *     reset on server restart. Used for every request whose assertion is
 *     not federated-rung (`sub_type: "member"`, or no sub_type rider).
 *   - "supabase" (MCP_VALUES_BACKEND=supabase) — RLS-delegated authz: values
 *     live in the RLS-protected `public.mcp_values` Supabase table, and this
 *     server forwards the
 *     INCOMING identity assertion verbatim as the PostgREST bearer. It
 *     never injects a user_id filter from its own verification — Supabase
 *     RLS (policies on auth.jwt()->>'sub'), not app code, enforces
 *     per-user isolation: authn at the MCP, authz delegated to Supabase.
 *     The verified `sub` is sent only as the insert's row value, and the
 *     policies' WITH CHECK proves the server can't lie about it. Used ONLY
 *     when the verified assertion's `sub_type` is "partner" (the federated
 *     rung) — the jwks app's issuer is the only one registered in Supabase
 *     third-party auth; member-rung assertions are signed by a different
 *     app key and their `sub` (our member id) means nothing to Supabase,
 *     so those requests stay on the in-memory Map even when the supabase
 *     backend is configured. Deliberately plain fetch against the PostgREST
 *     REST surface — no platform internals — so this ports unchanged to the
 *     public JS SDK (fetch or supabase-js).
 *   - "neon" (MCP_VALUES_BACKEND=neon) — the same RLS proof with Neon
 *     instead of Supabase: the assertion is forwarded verbatim to the Neon
 *     Data API (NEON_DATA_API_URL, PostgREST-compatible) and Neon RLS
 *     (policies on auth.user_id() via pg_session_jwt) enforces per-user
 *     isolation. Same
 *     partner-rung-only selection rule; same request shapes — the only
 *     difference is the base URL and that Neon takes just the JWT (no
 *     apikey header).
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import { NextResponse } from "next/server";

const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * Where the platform publishes the application assertion JWKS. Accepts a
 * comma-separated list — one URL per linked application (jwks + spa), so
 * both identity rungs verify against their own app's keys.
 */
const ASSERTION_JWKS_URLS = (process.env.MCP_ASSERTION_JWKS_URL ?? "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);
/** The audience the assertion must be bound to — this MCP server's URL. */
const MCP_SERVER_URL =
  process.env.MCP_SERVER_URL ?? "http://localhost:3200/api/mcp";

const jwksSets = ASSERTION_JWKS_URLS.map((url) =>
  createRemoteJWKSet(new URL(url)),
);

/**
 * Supabase project URL + publishable key — same env resolution as
 * lib/supabase.ts (explicit URL, else the IdP issuer minus `/auth/v1`).
 */
const SUPABASE_URL = (
  process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
  (process.env.NEXT_PUBLIC_IDP_ISSUER ?? "")
    .trim()
    .replace(/\/auth\/v1\/?$/, "")
).replace(/\/+$/, "");
const SUPABASE_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";

/**
 * Neon Data API base (PostgREST-compatible) for the neon backend — e.g.
 * https://app-<…>.dpl.myneon.app. Bearer-only: Neon authorizes from the JWT
 * alone, no apikey header.
 */
const NEON_DATA_API_URL = (process.env.NEON_DATA_API_URL ?? "")
  .trim()
  .replace(/\/+$/, "");

/**
 * Whether each PostgREST backend is AVAILABLE — the env opt-in plus the
 * connection values it needs. Availability is not selection: the backend is
 * chosen per request by `backendFor()` below.
 */
const SUPABASE_BACKEND_AVAILABLE = Boolean(
  process.env.MCP_VALUES_BACKEND === "supabase" &&
  SUPABASE_URL &&
  SUPABASE_PUBLISHABLE_KEY,
);
const NEON_BACKEND_AVAILABLE = Boolean(
  process.env.MCP_VALUES_BACKEND === "neon" && NEON_DATA_API_URL,
);

type ValuesBackend = "memory" | "supabase" | "neon";

/**
 * Pick the storage backend for ONE request. A PostgREST backend (supabase or
 * neon) only ever sees federated-rung assertions (`sub_type: "partner"`):
 * the jwks app's issuer is the only one registered with the partner store
 * (Supabase third-party auth / the Neon project's JWKS list), so member-rung
 * assertions — signed by a different app key, `sub` = our member id — would
 * fail PostgREST verification and mean nothing to RLS anyway. Every other
 * rung uses the in-memory Map.
 */
function backendFor(subType: string): ValuesBackend {
  if (subType !== "partner") return "memory";
  if (NEON_BACKEND_AVAILABLE) return "neon";
  if (SUPABASE_BACKEND_AVAILABLE) return "supabase";
  return "memory";
}

/**
 * The PostgREST surface behind each RLS backend. `apikey` is sent only
 * when set — Supabase's PostgREST requires it; Neon's Data API uses just
 * the JWT.
 */
interface PostgrestTarget {
  /** The mcp_values collection URL. */
  restUrl: string;
  apikey?: string;
}

const POSTGREST_TARGETS: Record<
  Exclude<ValuesBackend, "memory">,
  PostgrestTarget
> = {
  supabase: {
    restUrl: `${SUPABASE_URL}/rest/v1/mcp_values`,
    apikey: SUPABASE_PUBLISHABLE_KEY,
  },
  neon: { restUrl: `${NEON_DATA_API_URL}/mcp_values` },
};

function postgrestHeaders(
  target: PostgrestTarget,
  authorization: string,
): Record<string, string> {
  return {
    ...(target.apikey ? { apikey: target.apikey } : {}),
    authorization,
  };
}

/** Per-user scratchpad, keyed by the VERIFIED assertion subject. */
const store = new Map<string, Map<string, string>>();

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: number | string | null | undefined, result: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(
  id: number | string | null | undefined,
  code: number,
  message: string,
  status = 200,
) {
  return NextResponse.json(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
    { status },
  );
}

function toolText(text: string) {
  return { content: [{ type: "text", text }] };
}

const TOOLS = [
  {
    name: "get_value",
    description:
      "Read a value previously stored for the signed-in user. Returns the " +
      "value, or reports that nothing is stored under that key.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The key to read" },
      },
      required: ["key"],
    },
  },
  {
    name: "set_value",
    description: "Store a value for the signed-in user under a key.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The key to store under" },
        value: { type: "string", description: "The value to store" },
      },
      required: ["key", "value"],
    },
  },
];

/**
 * Token types this partner opts into. `identity_assertion` is
 * federation-proven; `identity_attribution` is caller-asserted (the
 * platform's attribution rung) — a stricter partner would drop the latter.
 */
const ACCEPTED_TOKEN_TYPES = new Set([
  "identity_assertion",
  "identity_attribution",
]);

interface VerifiedAssertion {
  sub: string;
  /** Which identity rung authenticated: "partner" (the partner IdP's own
   * subject), "member" (the platform's member id), or "identity" (the
   * caller-asserted identity key, attribution rung). */
  subType: string;
  /** The JWT `type` claim: "identity_assertion" (federation-proven) or
   * "identity_attribution" (caller-asserted). */
  tokenType: string;
}

/**
 * Verify the platform's identity assertion and return the user it is for,
 * plus the `sub_type` rider naming the identity rung and the `type` claim
 * naming the trust level. Returns null when the request is
 * unauthenticated/invalid — the caller answers 401, which is what an agent
 * connecting without (or with a stale) assertion observes.
 */
async function verifyAssertion(
  token: string,
): Promise<VerifiedAssertion | null> {
  if (!token) return null;
  for (const jwks of jwksSets) {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        audience: MCP_SERVER_URL,
      });
      if (typeof payload.sub !== "string" || !payload.sub) return null;
      const tokenType =
        typeof payload.type === "string" && payload.type
          ? payload.type
          : "identity_assertion";
      if (!ACCEPTED_TOKEN_TYPES.has(tokenType)) return null;
      return {
        sub: payload.sub,
        subType:
          typeof payload.sub_type === "string" && payload.sub_type
            ? payload.sub_type
            : "partner",
        tokenType,
      };
    } catch {
      // Signed by a different linked app's key (or invalid) — try the next
      // JWKS; fall through to 401 when none verifies.
    }
  }
  return null;
}

/**
 * RLS backends (supabase / neon) — plain fetch against a PostgREST
 * surface, identical request shapes for both. The incoming `Authorization`
 * header is forwarded VERBATIM: row visibility and the insert's WITH CHECK
 * are decided by the database's RLS evaluating the assertion's own `sub`
 * (Supabase: auth.jwt()->>'sub'; Neon: auth.user_id()), never by a filter
 * this server adds. PostgREST failures are surfaced as-is (status + body)
 * in the tool result text.
 */
async function postgrestGetValue(
  target: PostgrestTarget,
  authorization: string,
  key: string,
): Promise<
  { ok: true; value: string | undefined } | { ok: false; detail: string }
> {
  const response = await fetch(
    `${target.restUrl}?select=value&key=eq.${encodeURIComponent(key)}`,
    {
      headers: postgrestHeaders(target, authorization),
      cache: "no-store",
    },
  );
  if (!response.ok) {
    return {
      ok: false,
      detail: `PostgREST error ${response.status}: ${await response.text()}`,
    };
  }
  const rows = (await response.json()) as Array<{ value: string }>;
  return { ok: true, value: rows[0]?.value };
}

async function postgrestSetValue(
  target: PostgrestTarget,
  authorization: string,
  sub: string,
  key: string,
  value: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  // Upsert on the (user_id, key) primary key. `user_id: sub` is purely the
  // row VALUE being written — if this server lied about it, the RLS policy's
  // WITH CHECK (Supabase: auth.jwt()->>'sub' = user_id; Neon:
  // auth.user_id() = user_id) would reject the write.
  const response = await fetch(`${target.restUrl}?on_conflict=user_id,key`, {
    method: "POST",
    headers: {
      ...postgrestHeaders(target, authorization),
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      user_id: sub,
      key,
      value,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!response.ok) {
    return {
      ok: false,
      detail: `PostgREST error ${response.status}: ${await response.text()}`,
    };
  }
  return { ok: true };
}

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const assertion = await verifyAssertion(token);
  if (assertion === null) {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32001,
          message: "Unauthorized: a valid identity assertion is required",
        },
      },
      { status: 401 },
    );
  }

  let message: JsonRpcRequest;
  try {
    message = (await request.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }

  switch (message.method) {
    case "initialize":
      return rpcResult(message.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "sample-auth-partner-mcp", version: "0.1.0" },
      });

    // Notifications carry no id and expect no body.
    case "notifications/initialized":
      return new NextResponse(null, { status: 202 });

    case "ping":
      return rpcResult(message.id, {});

    case "tools/list":
      return rpcResult(message.id, { tools: TOOLS });

    case "tools/call": {
      const params = message.params ?? {};
      const name = params.name as string | undefined;
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const { sub, subType, tokenType } = assertion;
      // The attribution rung (`sub_type: "identity"`) always lands on the
      // in-memory backend via the same partner-rung-only rule below.
      const backend = backendFor(subType);
      const suffix = `(backend=${backend}, authenticated via sub_type=${subType}, type=${tokenType})`;

      if (name === "get_value") {
        const key = String(args.key ?? "");
        let value: string | undefined;
        if (backend !== "memory") {
          const result = await postgrestGetValue(
            POSTGREST_TARGETS[backend],
            authorization,
            key,
          );
          if (!result.ok) {
            return rpcResult(
              message.id,
              toolText(`${result.detail} ${suffix}`),
            );
          }
          value = result.value;
        } else {
          value = store.get(sub)?.get(key);
        }
        return rpcResult(
          message.id,
          toolText(
            value === undefined
              ? `No value stored under "${key}" for this user ${suffix}.`
              : `Value for "${key}": ${value} ${suffix}`,
          ),
        );
      }
      if (name === "set_value") {
        const key = String(args.key ?? "");
        const value = String(args.value ?? "");
        if (backend !== "memory") {
          const result = await postgrestSetValue(
            POSTGREST_TARGETS[backend],
            authorization,
            sub,
            key,
            value,
          );
          if (!result.ok) {
            return rpcResult(
              message.id,
              toolText(`${result.detail} ${suffix}`),
            );
          }
        } else {
          const userStore = store.get(sub) ?? new Map<string, string>();
          userStore.set(key, value);
          store.set(sub, userStore);
        }
        return rpcResult(
          message.id,
          toolText(`Stored "${key}" for this user ${suffix}.`),
        );
      }
      return rpcError(message.id, -32602, `Unknown tool: ${name}`);
    }

    default:
      return rpcError(
        message.id,
        -32601,
        `Method not found: ${message.method}`,
      );
  }
}
