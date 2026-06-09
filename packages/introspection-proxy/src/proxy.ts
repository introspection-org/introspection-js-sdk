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

export interface ProxyFetchOptions {
  egressProxyUrl?: string;
  egressProxyHosts?: string;
  forwardProxyUrl?: string;
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

/**
 * Returns `true` when `url`'s host should bypass the forward proxy because it
 * matches an entry in `NO_PROXY` / `no_proxy`.
 *
 * undici's `EnvHttpProxyAgent` already applies this to `fetch`, so the only
 * callers that need it explicitly are the OTLP exporters, which route through
 * `https-proxy-agent` (it ignores `NO_PROXY`). Keeping the matcher here lets
 * fetch and OTLP traffic agree on which hosts skip the proxy.
 *
 * Matching mirrors the common `NO_PROXY` convention: `*` bypasses everything,
 * entries match the host exactly or as a domain suffix (with or without a
 * leading dot), and an optional `:port` suffix on an entry is ignored.
 */
export function shouldBypassProxy(url: string): boolean {
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || "").trim();
  if (!noProxy) return false;
  if (noProxy === "*") return true;

  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }

  return noProxy
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => {
      const host = entry.replace(/:\d+$/, "").replace(/^\./, "");
      return (
        host.length > 0 && (hostname === host || hostname.endsWith(`.${host}`))
      );
    });
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

  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const hostname = new URL(toUrlString(input)).hostname.toLowerCase();

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

    return undiciFetch(
      target as unknown as Parameters<typeof undiciFetch>[0],
      opts as unknown as Parameters<typeof undiciFetch>[1],
    ) as unknown as Promise<Response>;
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
