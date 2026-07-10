/**
 * `@introspection-sdk/introspection-proxy`
 *
 * Lightweight, dependency-minimal helpers for routing `fetch`-based clients
 * through the Introspection egress credential-injection proxy or a standard
 * forward proxy. Depends only on undici and the zero-dependency
 * `@opentelemetry/api` (proxied requests emit `introspection-proxy-call`
 * spans that no-op unless the host process registers a tracer provider — no
 * OTel SDK or provider-SDK dependencies), so it can be used standalone (e.g.
 * alongside the `introspection-pi` instrumentation wrapper) without pulling
 * in the full `introspection-node` surface.
 */
export {
  getProxyDispatcher,
  createProxyFetch,
  installProxyFetch,
  resolveForwardProxyUrl,
} from "./proxy.js";
export type { ProxyFetchOptions } from "./proxy.js";
export { PROXY_CALL_SPAN_NAME, PROXY_TRACER_NAME } from "./tracing.js";
export type { ProxyMode } from "./tracing.js";
