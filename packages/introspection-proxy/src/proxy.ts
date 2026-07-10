/**
 * Outbound HTTP proxy helpers for `fetch`-based clients.
 *
 * Two proxy modes, selected per-request:
 *
 *  - **Egress credential-injection proxy** (`INTROSPECTION_EGRESS_URL`):
 *    plain-HTTP reverse proxy that routes by `Host` header and injects upstream
 *    credentials via ext_proc. Only used for hosts listed in
 *    `INTROSPECTION_ENDPOINT_HOSTS` (comma-separated). When the host list is
 *    empty, egress is disabled and all traffic uses the forward proxy.
 *
 *  - **Forward CONNECT proxy** (`HTTPS_PROXY` / `HTTP_PROXY`): opaque TLS
 *    tunnel the proxy cannot read or modify. Used for all other hosts (S3,
 *    GitHub, npm, etc.).
 */
import { Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import {
  Agent,
  EnvHttpProxyAgent,
  buildConnector,
  fetch as undiciFetch,
  type Dispatcher,
} from "undici";
import {
  matchesNoProxy,
  parseNoProxyEntries,
  tracedProxyCall,
} from "./tracing.js";

export interface ProxyFetchOptions {
  egressProxyUrl?: string;
  egressProxyHosts?: string;
  forwardProxyUrl?: string;
  /**
   * Emit an `introspection-proxy-call` OTel span per proxied request
   * (default true). Spans no-op unless the host process registered a tracer
   * provider. Direct requests (no proxy, or `NO_PROXY` hosts) never get a
   * span regardless of this flag.
   */
  tracing?: boolean;
}

function resolveEgressUrl(options: ProxyFetchOptions): string | undefined {
  return options.egressProxyUrl ?? process.env.INTROSPECTION_EGRESS_URL;
}

function resolveEgressHosts(options: ProxyFetchOptions): Set<string> {
  const raw =
    options.egressProxyHosts ?? process.env.INTROSPECTION_ENDPOINT_HOSTS ?? "";
  return new Set(
    raw
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function resolveForwardProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    undefined
  );
}

function buildEgressDispatcher(proxyUrl: string): Dispatcher {
  const url = new URL(proxyUrl);
  const useTls = url.protocol === "https:";
  const port = Number(url.port) || (useTls ? 443 : 80);
  const host = url.hostname;

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
 * Returns a single dispatcher. When egress hosts are scoped, returns the
 * forward dispatcher (the egress/forward split is per-request inside
 * {@link createProxyFetch}).
 */
export function getProxyDispatcher(
  options: ProxyFetchOptions = {},
): Dispatcher | undefined {
  const egressUrl = resolveEgressUrl(options);
  const egressHostSet = resolveEgressHosts(options);
  if (egressUrl && egressHostSet.size > 0) {
    return buildEgressDispatcher(egressUrl);
  }
  if (resolveForwardProxyUrl()) {
    return new EnvHttpProxyAgent();
  }
  return undefined;
}

function toUrlString(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

function downgradeToHttp(url: string | URL): string {
  const s = typeof url === "string" ? url : url.toString();
  return s.startsWith("https://") ? "http://" + s.slice(8) : s;
}

export function createProxyFetch(
  options: ProxyFetchOptions = {},
): typeof fetch {
  // Capture the real fetch now, before installProxyFetch swaps
  // globalThis.fetch to this wrapper. The per-request fallback below must not
  // re-read the global, or it would recurse into the installed proxy.
  const base = globalThis.fetch;
  const egressUrl = resolveEgressUrl(options);
  const egressHosts = resolveEgressHosts(options);
  const egressIsPlainHttp =
    !!egressUrl && new URL(egressUrl).protocol === "http:";

  const egress = egressUrl ? buildEgressDispatcher(egressUrl) : undefined;
  const forward = resolveForwardProxyUrl()
    ? new EnvHttpProxyAgent()
    : undefined;

  if (!egress && !forward) return base;

  const tracing = options.tracing ?? true;
  // Snapshot NO_PROXY once, like EnvHttpProxyAgent does at construction. Used
  // only to decide span emission — undici owns the actual routing.
  const noProxyEntries = parseNoProxyEntries(process.env);

  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(toUrlString(input));
    const hostname = url.hostname.toLowerCase();

    const useEgress =
      !!egress && egressHosts.size > 0 && egressHosts.has(hostname);
    const dispatcher = useEgress ? egress : forward;

    if (!dispatcher) return base(input, init);

    let target: string | URL;
    let opts: Record<string, unknown>;

    if (typeof Request !== "undefined" && input instanceof Request) {
      target = input.url;
      opts = {
        method: input.method,
        headers: input.headers,
        body: input.body,
        signal: input.signal,
        redirect: input.redirect,
        credentials: input.credentials,
        ...init,
        dispatcher,
      };
      if (input.body != null) opts.duplex = "half";
    } else {
      target = input as string | URL;
      opts = { ...init, dispatcher };
    }

    if (useEgress && egressIsPlainHttp) {
      target = downgradeToHttp(target);
    }

    const execute = () =>
      undiciFetch(
        target as unknown as Parameters<typeof undiciFetch>[0],
        opts as unknown as Parameters<typeof undiciFetch>[1],
      ) as unknown as Promise<Response>;

    // A forward-dispatched request to a NO_PROXY host goes direct inside
    // EnvHttpProxyAgent — no proxy hop, so no proxy span (in-cluster clients
    // trace those calls themselves as `introspection-api-call`).
    const viaProxy =
      useEgress || !matchesNoProxy(hostname, url.port, noProxyEntries);
    if (!tracing || !viaProxy) return execute();

    const method = (
      init?.method ??
      (typeof Request !== "undefined" && input instanceof Request
        ? input.method
        : "GET")
    ).toUpperCase();
    return tracedProxyCall(
      useEgress ? "egress" : "forward",
      method,
      url,
      execute,
    );
  };
}

export function installProxyFetch(options: ProxyFetchOptions = {}): () => void {
  const original = globalThis.fetch;
  const proxied = createProxyFetch(options);
  if (proxied === original) return () => {};
  globalThis.fetch = proxied;
  return () => {
    if (globalThis.fetch === proxied) {
      globalThis.fetch = original;
    }
  };
}
