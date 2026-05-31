/**
 * Outbound HTTP proxy helpers for `fetch`-based clients.
 *
 * These let any `fetch` call — a bare `fetch(...)`, an SDK that accepts a
 * custom `fetch` (e.g. `@supabase/supabase-js` via `global.fetch`), or every
 * request in a process (via {@link installProxyFetch}) — be routed through a
 * proxy so the caller does not have to hold upstream credentials.
 *
 * Two proxy shapes are supported, selected from the environment:
 *
 *  - **Egress credential-injection proxy** (`EGRESS_PROXY_URL`): the
 *    Introspection egress proxy is a plain-HTTP reverse proxy that routes by
 *    the request's `Host`/`:authority` header and injects the real upstream
 *    credential (so the process can send a placeholder/locator token). We dial
 *    the proxy on every connection but leave the request — including its real
 *    `Host` and `https:` scheme — untouched, which is exactly what the proxy
 *    needs to route and inject. undici speaks HTTP/1.1 over the socket we hand
 *    it, so no URL rewriting is required.
 *
 *  - **Standard forward (CONNECT) proxy** (`HTTPS_PROXY` / `HTTP_PROXY`,
 *    honouring `NO_PROXY`): the same kind of proxy the OTLP exporter uses via
 *    {@link withOtlpHttpsProxy}, but exposed as an undici dispatcher so it
 *    works with `fetch`. (`HttpsProxyAgent` is a Node `http.Agent` and is
 *    ignored by `fetch`, which only accepts an undici `dispatcher`.)
 *
 * `EGRESS_PROXY_URL` takes precedence when both are set.
 *
 * Note: in egress mode the dispatcher routes *all* requests through the proxy,
 * so destinations must be configured on the proxy. This matches the intended
 * "all egress goes through the proxy" model for sandboxed recipes.
 */
import { Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import {
  Agent,
  EnvHttpProxyAgent,
  ProxyAgent,
  buildConnector,
  fetch as undiciFetch,
  type Dispatcher,
} from "undici";

export interface ProxyFetchOptions {
  /**
   * Egress (credential-injection) proxy URL. Defaults to
   * `process.env.EGRESS_PROXY_URL` (e.g. `http://localhost:10000`).
   */
  egressProxyUrl?: string;
  /**
   * Standard forward-proxy URL. Defaults to the `HTTPS_PROXY` / `HTTP_PROXY`
   * environment variables (which also honour `NO_PROXY`). Used only when no
   * egress proxy is configured.
   */
  forwardProxyUrl?: string;
}

function resolveEgressProxyUrl(options: ProxyFetchOptions): string | undefined {
  return options.egressProxyUrl ?? process.env.EGRESS_PROXY_URL ?? undefined;
}

/**
 * Resolve a standard forward-proxy URL from the environment, honouring the
 * conventional `HTTPS_PROXY` / `HTTP_PROXY` variables (and their lowercase
 * forms). Shared with the OTLP exporter proxy helper (`withOtlpHttpsProxy`) so
 * fetch traffic and OTLP traffic resolve the same proxy.
 */
export function resolveForwardProxyUrl(): string | undefined {
  const env = process.env;
  return (
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    undefined
  );
}

function buildEgressDispatcher(proxyUrl: string): Dispatcher {
  const url = new URL(proxyUrl);
  const useTls = url.protocol === "https:";
  const port = Number(url.port) || (useTls ? 443 : 80);
  const host = url.hostname;

  // Always connect to the proxy, regardless of the request's destination. The
  // request keeps its real `Host`, which is what the proxy routes + injects on.
  return new Agent({
    connect(
      _options: buildConnector.Options,
      callback: buildConnector.Callback,
    ): void {
      if (useTls) {
        const socket = tlsConnect({ host, port, servername: host });
        socket.once("secureConnect", () => callback(null, socket));
        socket.once("error", (err) => callback(err, null));
      } else {
        const socket = new Socket();
        socket.connect(port, host, () => callback(null, socket));
        socket.once("error", (err) => callback(err, null));
      }
    },
  });
}

/**
 * Build an undici {@link Dispatcher} for outbound HTTP based on the
 * environment (or explicit {@link ProxyFetchOptions}). Returns `undefined`
 * when no proxy is configured, so callers can fall back to the default fetch.
 */
export function getProxyDispatcher(
  options: ProxyFetchOptions = {},
): Dispatcher | undefined {
  const egressUrl = resolveEgressProxyUrl(options);
  if (egressUrl) {
    return buildEgressDispatcher(egressUrl);
  }

  if (options.forwardProxyUrl) {
    return new ProxyAgent(options.forwardProxyUrl);
  }

  if (resolveForwardProxyUrl()) {
    // Reads HTTPS_PROXY / HTTP_PROXY / NO_PROXY from the environment.
    return new EnvHttpProxyAgent();
  }

  return undefined;
}

/**
 * A `fetch`-compatible function that routes through the configured proxy.
 * Drop-in for any client that accepts a `fetch` (e.g. supabase-js
 * `createClient(url, key, { global: { fetch: createProxyFetch() } })`).
 *
 * When no proxy is configured this returns the global `fetch` unchanged, so it
 * is safe to use unconditionally (local dev keeps talking directly to APIs).
 */
export function createProxyFetch(options: ProxyFetchOptions = {}): typeof fetch {
  const dispatcher = getProxyDispatcher(options);
  if (!dispatcher) {
    return fetch;
  }

  const proxied = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    return undiciFetch(
      input as unknown as Parameters<typeof undiciFetch>[0],
      { ...init, dispatcher } as unknown as Parameters<typeof undiciFetch>[1],
    ) as unknown as Promise<Response>;
  };

  return proxied as typeof fetch;
}

/**
 * Replace `globalThis.fetch` so existing bare `fetch(...)` calls — and any SDK
 * that uses the global fetch by default, including supabase-js — route through
 * the configured proxy with no other code changes. No-op when no proxy is
 * configured.
 *
 * Returns a function that restores the original `fetch`.
 */
export function installProxyFetch(options: ProxyFetchOptions = {}): () => void {
  const dispatcher = getProxyDispatcher(options);
  if (!dispatcher) {
    return () => {};
  }

  const original = globalThis.fetch;
  globalThis.fetch = createProxyFetch(options);
  return () => {
    globalThis.fetch = original;
  };
}
