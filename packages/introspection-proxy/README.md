# @introspection-sdk/introspection-proxy

Route outbound `fetch` calls through the Introspection egress proxy for credential injection, or through a standard CONNECT forward proxy.

## Quick start

```ts
import { installProxyFetch } from "@introspection-sdk/introspection-proxy";

// Replace globalThis.fetch — all subsequent fetch() calls route through the proxy.
// No-op when no proxy env vars are set (safe for local dev).
installProxyFetch();

// Every fetch now goes through the configured proxy.
const res = await fetch("https://api.openai.com/v1/models");
```

## Environment variables

| Variable                       | Purpose                                                                                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `INTROSPECTION_EGRESS_URL`     | Egress reverse proxy URL (e.g. `http://localhost:10000`). Sends requests as plain HTTP so the proxy can route by `Host` header and inject credentials via ext_proc.                                                                        |
| `INTROSPECTION_ENDPOINT_HOSTS` | Comma-separated hostnames that should use the egress proxy (e.g. `api.openai.com,api.anthropic.com`). When set, only matching hosts use egress; all others fall through to the CONNECT proxy. When unset, all traffic goes through egress. |
| `HTTPS_PROXY` / `HTTP_PROXY`   | Standard forward proxy. Used as the CONNECT tunnel for hosts not in `INTROSPECTION_ENDPOINT_HOSTS`.                                                                                                                                        |

## Per-client usage

If you only want to proxy a single client (not the whole process):

```ts
import { createProxyFetch } from "@introspection-sdk/introspection-proxy";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(url, key, {
  global: { fetch: createProxyFetch() },
});
```

Active W3C trace context is injected into proxied requests. OTel baggage is
excluded by default because it can contain conversation or identity metadata.
Enable it only for a trusted application endpoint that participates in the
same distributed trace:

```ts
const mcpFetch = createProxyFetch({ propagateBaggage: true });
```

## Lazy process bootstrap

Processes that must install proxy enforcement before serving traffic can defer
loading Undici until after their listener binds:

```ts
import { installLazyProxyFetch } from "@introspection-sdk/introspection-proxy/lazy";

const proxyFetch = installLazyProxyFetch();

server.listen(port, () => {
  void proxyFetch.ready();
});
```

The guard replaces `globalThis.fetch` synchronously. Requests made before
`ready()` completes wait for the same promise, so initialization cannot be
bypassed or duplicated.

## How it works

Two proxy modes, selected per-request:

- **Egress credential-injection proxy** (`INTROSPECTION_EGRESS_URL`): plain-HTTP reverse proxy that routes by `Host` header and injects upstream credentials via ext_proc. Only used for hosts in `INTROSPECTION_ENDPOINT_HOSTS`.

- **Forward CONNECT proxy** (`HTTPS_PROXY`): opaque TLS tunnel the proxy cannot read or modify. Used for all other hosts (S3, GitHub, npm, etc.).
