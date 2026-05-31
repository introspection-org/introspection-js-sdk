/**
 * `@introspection-sdk/introspection-proxy`
 *
 * Lightweight, dependency-minimal (undici only) helpers for routing
 * `fetch`-based clients through the Introspection egress credential-injection
 * proxy or a standard forward proxy. Has no OpenTelemetry or provider-SDK
 * dependencies, so it can be used standalone (e.g. alongside the
 * `introspection-pi` instrumentation wrapper) without pulling in the full
 * `introspection-node` surface.
 */
export {
  getProxyDispatcher,
  createProxyFetch,
  installProxyFetch,
  resolveForwardProxyUrl,
} from "./proxy.js";
export type { ProxyFetchOptions } from "./proxy.js";
