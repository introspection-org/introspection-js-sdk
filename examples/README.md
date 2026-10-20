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
  run. A `native` application's email-code sign-in is the
  `api-native-email-code` script below.

## REST API

```bash
pnpm api-runtimes                 # Runner walkthrough: resolve by slug, tasks + file ops
pnpm api-native-email-code <email> # Native email-code sign-in, then a task as that user
pnpm api-connectors-slack         # Create a Slack connector and authorize a workspace
pnpm api-connectors-pipedream     # Create a Pipedream connector and authorize one app
pnpm api-connectors-custom-app    # Registry search + OAuth discovery for a custom MCP app (Linear)
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

## Pi instrumentation

Pi is the supported agent-instrumentation path.

```bash
pnpm pi-native                    # IntrospectionPiInstrumentor
pnpm pi-init                      # introspection.init() + instrumentPi(agent, meta)
pnpm pi-subagents                 # Multi-agent baggage
```

### Dual export

Pi spans can fan out to a second backend alongside Introspection: build the
provider yourself with both span processors, then let `init({ tracerProvider })`
adopt it.

```bash
pnpm pi-dual-export               # + a second OTLP backend
```

## Docs pattern snippets

`observe/`, `identity/` and `patterns/` back the code blocks on the docs'
pattern, observe and identity pages, one module per page; `browser/` holds the
browser side of the web-chat page as its own package (DOM types, typecheck
only). The docs extract the code between `// #region docs:<id>` and
`// #endregion docs:<id>` at a pinned release tag; the code around a region
does the setup the docs leave out. Prettier skips these folders so the regions
keep the docs' layout.

```bash
pnpm observe-feedback-events         # IntrospectionLogs feedback + track for a conversation
pnpm identity-agents                 # Runner for an end user
pnpm identity-sharing                # Share a conversation
pnpm patterns-add-to-your-app        # Service-account runner, start, reconnect, feedback
pnpm patterns-agent-follow-ups       # Time zone on the task
pnpm patterns-approve-outside        # Steer with a <user_action>
pnpm patterns-ask-the-user           # Detect an interrupt and resume it
pnpm patterns-files                  # Upload, attach, download
pnpm patterns-multi-tenant           # End-user tags + per-task metadata
pnpm patterns-per-user-tools         # Mint a connector authorize link for an end user
pnpm patterns-per-user-tools-connect # The end user's own connect button
pnpm patterns-structured-output      # Read submit_result args from the stream, validate
pnpm patterns-trigger                # Task per webhook event, batch in waves
pnpm patterns-web-chat               # Broker route (service account) + federated variant
```

## Manual instrumentation

There are no examples for it here — the OTel examples cover Pi only. For
everything else, instrument against the OTel APIs directly and attach
`IntrospectionSpanProcessor`, emitting spans in GenAI semantic conventions.
See `llms.txt`.

## Directory Structure

```
examples/
  api/              # REST API (no OTel)
  otel/             # OTel instrumentation examples (Pi only)
    pi/             # Pi Agent
    run_all.sh      # Run all OTel examples
```
