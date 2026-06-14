# auth — B2B2C auth modes & per-application signing keys

A minimal Next.js app that shows how a partner application signs its end users
into Introspection — and how **per-application signing keys** let a partner MCP
server authenticate the platform's calls as the end user. One route per mode;
the landing page (`/`) is the decision table.

Every mode obtains an Introspection token → exchanges it at the Data Plane for
an `intro_dp_session` cookie → then creates and streams a task against a
runtime, **with no API key in the browser**.

> Talks to Introspection purely over HTTP (Control Plane + Data Plane URLs are
> env vars) — no SDK package or monorepo wiring required. Works against the
> hosted platform (`https://api.introspection.dev`) or a self-hosted stack.

## What it demonstrates

| Route              | Application type   | Who it's for                                           | End-user identity                                  |
| ------------------ | ------------------ | ------------------------------------------------------ | -------------------------------------------------- |
| `/jwks`            | `jwks`             | You have your own IdP (Supabase, Auth0, any JWKS)      | `customer` member, proven by the partner IdP       |
| `/spa`             | `spa`              | Introspection-hosted login (PKCE), optionally brokered | Introspection member (or `customer` if brokered)   |
| `/service-account` | `service_account`  | No end users (server / CI)                             | caller-asserted via `metadata.identity`            |
| `/api/mcp`         | partner MCP server | the integration partner's MCP                          | the verified assertion `sub` (per-user scratchpad) |

The headline for partners: in `/jwks` mode the same app **also plays the
partner MCP server** (`app/api/mcp`). Every MCP request carries a
platform-minted **identity assertion** (a short-lived ES256 JWT signed with the
application's own key) which the server verifies against the application's
published JWKS — so the partner authenticates the end user without ever holding
an Introspection credential. See
https://docs.introspection.dev/platform/applications.

## Prerequisites

- **Node ≥ 22** and `pnpm`.
- An **Introspection project** and an owner **API token** (for the one-time
  application setup below).
- For `/jwks`: a **Supabase project with asymmetric JWT signing keys**
  (ES256/RS256) enabled, so its JWKS is published at
  `{issuer}/.well-known/jwks.json`. Legacy HS256 shared-secret tokens are
  rejected. (`/spa` and `/service-account` need no external IdP.)

## Create the applications

Each mode needs an application on your Introspection project — a `spa`, a
`service_account` (with a minted secret), and/or a `jwks` application with its
IdP issuer attached. The partner MCP demo additionally needs this app's
`/api/mcp` registered as a `kind: mcp` endpoint and linked to the `jwks`
application (the link installs the app's ES256 assertion signing keys). Create
them on the Control Plane and note each `client_id` (and the service-account
`intro_sk_…` secret, shown once) for the env vars below — see the
[Applications & Auth guide](https://docs.introspection.dev/platform/applications).
The app's assertion
JWKS, which the sample MCP verifies against, is published at
`{CP}/v1/applications/<jwks_client_id>/.well-known/jwks.json`.

## Configure & run

```bash
cp .env.example .env.local
# fill in the client ids / secret / issuer for the modes you created above
# (NEXT_PUBLIC_INTROSPECTION_PROJECT_ID, *_CP_URL, *_DP_URL are required)

pnpm install                                          # from the repo root
pnpm --filter introspection-example-sample-auth dev   # → http://localhost:3200
# or: cd examples/auth && pnpm dev
```

`/jwks` signs in at Supabase headlessly (session reuse or `signInWithPassword`),
exchanges the Supabase access token via RFC 8693 token-exchange, opens the DP
session, then creates a task whose events stream into the page. Its default
prompt ("remember my favorite color…") exercises the MCP round-trip:
`mcp_get_value` / `mcp_set_value` are auto-discovered as agent tools and the
assertion is injected at the egress boundary — the agent never sees it.

## Database-enforced isolation (RLS) — optional

By default the MCP stores values in an in-process Map (`MCP_VALUES_BACKEND=memory`).
Point it at **Supabase** or **Neon** (`MCP_VALUES_BACKEND=supabase|neon`) to demo
database-enforced isolation: values live in an RLS-protected `mcp_values` table,
and the MCP forwards the identity assertion **verbatim** to PostgREST — so the
database (not app code) scopes every read/write by the assertion's `sub`. The
MCP route is deliberately plain `fetch` against the PostgREST surface, so the
pattern ports unchanged to `supabase-js` or the JS SDK. Requires the app's
issuer registered as a third-party auth integration and the table provisioned;
see https://docs.introspection.dev/platform/applications.

## Notes

- **`/jwks` and `/spa` (brokered) can't run fully offline.** `/jwks` needs a
  reachable Supabase project; brokered `/spa` needs a real federation
  provisioned for the `spa` application. The hosted-login `/spa` and
  `/service-account` modes run against just the platform.
- **No API key in the browser.** Secrets (the service-account secret, the IdP
  client secret) stay server-side; the browser only ever holds the end user's
  own IdP token and the HttpOnly `intro_dp_session` cookie.
- **CORS / cookies.** All modes call DP `/v1/oauth/exchange` cross-origin with
  `credentials: include`; the SPA flow also calls CP `/v1/oauth/token`
  cross-origin. Both must allow `http://localhost:3200`. In production, serve
  under one registrable domain (the DP sets `SameSite=None; Secure` off-local).
