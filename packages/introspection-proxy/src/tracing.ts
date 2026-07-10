/**
 * OpenTelemetry span instrumentation for proxied requests.
 *
 * Emits one `introspection-proxy-call` CLIENT span per request that is
 * actually routed through a proxy (egress credential-injection or forward
 * CONNECT). Requests that go direct — no proxy configured, or the host is
 * excluded via `NO_PROXY` — deliberately get no span: in-cluster callers
 * (`NO_PROXY` covers the DP API) already trace those calls at the client
 * layer, so proxy spans and client-layer spans stay mutually exclusive.
 *
 * Depends only on `@opentelemetry/api`: without a registered tracer provider
 * every span here is a no-op, so the package stays safe to load in bare Node
 * processes (e.g. the sandbox `NODE_OPTIONS` preload).
 *
 * Attributes are intentionally lean — transport shape only (method, host,
 * port, query-stripped URL, proxy mode, status). Tenant/task identity is
 * inferred server-side from the request's JWT, or stamped globally by the
 * host process's span processors, never duplicated here. Query strings are
 * stripped because they can carry capability tokens (presigned URLs,
 * share ids).
 */
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

export const PROXY_CALL_SPAN_NAME = "introspection-proxy-call";
export const PROXY_TRACER_NAME = "@introspection-sdk/introspection-proxy";

export type ProxyMode = "egress" | "forward";

/**
 * Parse `NO_PROXY`/`no_proxy` into normalized entries. Mirrors undici's
 * `EnvHttpProxyAgent` semantics closely enough to decide span emission —
 * undici still owns the actual routing decision.
 */
export function parseNoProxyEntries(env: NodeJS.ProcessEnv): string[] {
  const raw = env.NO_PROXY ?? env.no_proxy ?? "";
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/** Whether `hostname[:port]` matches a `NO_PROXY` entry (i.e. goes direct). */
export function matchesNoProxy(
  hostname: string,
  port: string,
  entries: string[],
): boolean {
  for (const raw of entries) {
    if (raw === "*") return true;
    let entry = raw;
    let entryPort = "";
    const colon = entry.lastIndexOf(":");
    if (colon !== -1 && !entry.slice(colon).includes("]")) {
      entryPort = entry.slice(colon + 1);
      entry = entry.slice(0, colon);
    }
    if (entryPort && entryPort !== port) continue;
    if (entry.startsWith(".")) entry = entry.slice(1);
    if (hostname === entry || hostname.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/** Run `execute` inside an `introspection-proxy-call` CLIENT span. */
export function tracedProxyCall(
  mode: ProxyMode,
  method: string,
  url: URL,
  execute: () => Promise<Response>,
): Promise<Response> {
  const tracer = trace.getTracer(PROXY_TRACER_NAME);
  const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
  return tracer.startActiveSpan(
    PROXY_CALL_SPAN_NAME,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "http.request.method": method,
        "server.address": url.hostname,
        "server.port": port,
        "url.full": url.origin + url.pathname,
        "url.path": url.pathname,
        "introspection.proxy.mode": mode,
      },
    },
    async (span) => {
      try {
        const response = await execute();
        span.setAttribute("http.response.status_code", response.status);
        if (response.status >= 400) {
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        return response;
      } catch (err) {
        span.recordException(err instanceof Error ? err : String(err));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}
