# Introspection SDK Examples

## Setup

```bash
cp .env.example .env   # fill in API keys
pnpm install
```

## Apps

Full runnable apps (their own package + README), not single scripts:

- [`auth`](./auth) — B2B2C auth modes (JWKS federation, hosted-login SPA,
  service account) and a partner MCP server authenticated by per-application
  identity-assertion signing keys. `cd auth` and see its README to set up and
  run.

## REST API

```bash
pnpm api-runtimes                 # Runner walkthrough: resolve by slug, tasks + file ops
```

## Egress Proxy

Route third-party API calls through the Introspection egress (reverse) proxy so
credentials are injected by the proxy instead of held in the process. Set
`INTROSPECTION_EGRESS_URL` (e.g. `http://localhost:10000`); when unset the helpers are
no-ops and code talks to the APIs directly.

There are two ways to wire it, compared on Supabase:

- **Global** — `installProxyFetch()` swaps `globalThis.fetch` once; the whole
  process routes through the proxy.
- **Manual** — `createProxyFetch()` is passed to a single client (e.g.
  supabase-js's `global.fetch`); only that client is proxied.

```bash
pnpm proxy-supabase-global        # installProxyFetch(): swaps global fetch, whole process
pnpm proxy-supabase-manual        # createProxyFetch(): scoped to one supabase-js client
pnpm proxy-typesense              # Typesense (axios): installProxyFetch + axiosAdapter "fetch"
pnpm proxy-deepwiki               # DeepWiki MCP (@modelcontextprotocol/sdk) via transport fetch
pnpm proxy-deepwiki-mcporter      # DeepWiki MCP (mcporter): installProxyFetch + introspection-proxy-call spans
```

For **axios-based clients (e.g. Typesense), use the global install** — axios has
no per-client `fetch` option (its built-in fetch adapter always uses the global
fetch), so `installProxyFetch()` + `axiosAdapter: "fetch"` is the recommended
pattern. `fetch`-native clients (supabase-js, the MCP SDK) can use either.

## Optional OTLP instrumentation

Instrumentation examples are independent from the execution SDK. The generic
example uses raw OpenTelemetry APIs:

```bash
pnpm raw-conversation              # Multi-turn conversation with raw OTel APIs
```

## Directory Structure

```
examples/
  api/              # REST API (no OTel)
  otel/raw/         # Raw OTEL (no framework)
```
