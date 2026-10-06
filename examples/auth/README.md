# auth — B2B2C auth modes & per-application signing keys

A minimal Next.js app that shows how a partner application signs its end users
into Introspection — and how **per-application signing keys** let a partner MCP
server authenticate the platform's calls as the end user. One route per mode;
the landing page (`/`) is the decision table.

Every mode obtains an Introspection token → exchanges it at the Data Plane for
an `intro_dp_session` cookie → then creates and streams a task against a
runtime, **with no API key in the browser**.

> Uses the SDK workspace packages for every Introspection call. The confidential
> broker resolves the Data Plane URL and runtime server-side; local Data Plane
> traffic goes through a same-origin proxy so the session cookie behaves like it
> does in deployment. Works against the hosted platform
> (`https://api.introspection.dev`) or a self-hosted stack.

## What it demonstrates

| Route              | Application type   | Who it's for                                           | End-user identity                                  |
| ------------------ | ------------------ | ------------------------------------------------------ | -------------------------------------------------- |
| `/jwks`            | `jwks`             | You have your own IdP (Supabase, Auth0, any JWKS)      | `customer` member, proven by the partner IdP       |
| `/spa`             | `spa`              | Introspection-hosted login (PKCE), optionally brokered | Introspection member (or `customer` if brokered)   |
| `/service-account` | `service_account`  | No end users (server / CI)                             | caller-asserted via `metadata.identity`            |
| `/api/mcp`         | partner MCP server | the integration partner's MCP                          | the verified assertion `sub` (per-user scratchpad) |

Application types are mutually exclusive: each offers one way in, and an app
that needs two registers two applications. That is why this sample asks for a
separate `service_account` application even in the `/jwks` and `/spa` modes —
its broker resolves runtimes on the Control Plane with it.

| Type              | Sign-in it offers                                        | Grants                                       | Secret |
| ----------------- | -------------------------------------------------------- | -------------------------------------------- | ------ |
| `service_account` | Server credentials                                       | `client_credentials`                         | Yes    |
| `jwks`            | Your own IdP's JWT, exchanged by RFC 8693 token exchange | none (gated on its attached issuers)         | No     |
| `spa`             | Introspection-hosted login, optionally brokered          | `authorization_code` + PKCE, `refresh_token` | No     |
| `native`          | Email codes on Introspection accounts (mobile, desktop)  | `email_code`, `device_code`, `refresh_token` | No     |

The grants are derived from the type; you never send them. The `device_code`
grant is in the `native` list but is not yet reachable with an application's
`client_id`. Types other than `service_account` need a Max or Enterprise plan.
A `native` app has
no route here, because its sign-in runs in the app rather than in a browser
broker: see [`examples/api/native-email-code.ts`](../api/native-email-code.ts)
and `AuthClient` in `@introspection-sdk/introspection-node`. Its token is a
Data Plane credential for a `customer` member, so it runs tasks by
`runtime_id` and does not call Control Plane routes.

The headline for partners: in `/jwks` mode the same app **also plays the
partner MCP server** (`app/api/mcp`). Every MCP request carries a
platform-minted **identity assertion** (a short-lived ES256 JWT signed with the
application's own key) which the server verifies against the application's
published JWKS — so the partner authenticates the end user without ever holding
an Introspection credential. See
https://docs.introspection.dev/platform/applications.

## Prerequisites

- **Node ≥ 22** and `pnpm`.
- The [`introspection` CLI](https://docs.introspection.dev/cli) and
  **organization owner access** to a project — creating applications / IdPs /
  endpoints is an owner/admin operation (`introspection login` signs you in as
  that member; a project API key can't do it).
- For `/jwks`: a **Supabase project with asymmetric JWT signing keys**
  (ES256/RS256) enabled, so its JWKS is published at
  `{issuer}/.well-known/jwks.json`. Legacy HS256 shared-secret tokens are
  rejected. (`/spa` and `/service-account` need no external IdP.)

## Create the applications

Install the CLI, authenticate once as an org owner, then create one application
per mode. Note each printed `client_id` for the env vars below.

```bash
npm install -g @introspection-ai/cli   # or run any command via `npx @introspection-ai/cli …`

introspection login   # signs in as your member; selects your project
```

**SPA** (hosted login):

```bash
introspection applications create --type spa --name "Hosted SPA" \
  --redirect-uri http://localhost:3200/callback \
  --allowed-origin http://localhost:3200
# → client_id → NEXT_PUBLIC_INTROSPECTION_SPA_CLIENT_ID
```

**Service account** (machine token):

```bash
introspection applications create --type service-account --name "CI runner"
# → client_id → INTROSPECTION_SERVICE_ACCOUNT_CLIENT_ID (note the printed `id`)
introspection applications secrets create --app <service_account_app_id>
# → secret, shown once → INTROSPECTION_SERVICE_ACCOUNT_CLIENT_SECRET
```

Applications carry no secret themselves; a `service_account` holds one or more
client secrets, minted separately so they can be rotated.

**JWKS** (bring-your-own-IdP) **+ partner MCP endpoint**. `--issuer` attaches
the IdP to the new application; a `jwks` app verifies the IdP's own JWT against
`{issuer}/.well-known/jwks.json` and has no redirect URIs:

```bash
introspection applications create --type jwks --name "Partner JWKS" \
  --allowed-origin http://localhost:3200 \
  --issuer https://<ref>.supabase.co/auth/v1
# → client_id → FEDERATED_CLIENT_ID  (note the printed `id` for --app below)

# Register this app's /api/mcp endpoint and link it
# (the link installs the application's ES256 assertion signing keys):
introspection endpoints create --name "sample-auth partner mcp" \
  --base-url http://host.docker.internal:3200/api/mcp \
  --assertion-claim role=authenticated \
  --app <jwks_app_id>
```

The app's assertion JWKS — which the sample MCP verifies against — is published
at `{CP}/v1/applications/<jwks_client_id>/.well-known/jwks.json` →
`MCP_ASSERTION_JWKS_URL`. See the
[Applications & Auth guide](https://docs.introspection.dev/platform/applications)
for details.

## Configure & run

```bash
cp .env.example .env.local
# fill in the client ids / secret / issuer for the modes you created above
# (NEXT_PUBLIC_INTROSPECTION_PROJECT and *_CP_URL are required)

pnpm install                                   # from the repo root
pnpm --filter introspection-example-auth dev   # → http://localhost:3200
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
