import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";

/**
 * Attach a forward-proxy agent to OTLP exporter options when a proxy is
 * configured for the exporter's endpoint.
 *
 * The OTLP proto exporters use Node's `http`/`https` stack, so this uses
 * `HttpsProxyAgent` (an `http.Agent`) rather than the undici dispatcher from
 * this package's main entry point — a dispatcher only applies to `fetch`.
 * Unlike undici's `EnvHttpProxyAgent`, `HttpsProxyAgent` ignores `NO_PROXY`,
 * so we resolve the proxy per-endpoint with `proxy-from-env`'s
 * {@link getProxyForUrl}, which returns `""` when the host matches `NO_PROXY`.
 * This keeps in-cluster endpoints (e.g. `*.svc.cluster.local`) on a direct
 * connection instead of tunnelling them through the egress proxy, which has no
 * route for them.
 */
export function withOtlpHttpsProxy<T extends { url?: string }>(options: T): T {
  const proxyUrl = options.url ? getProxyForUrl(options.url) : "";
  if (!proxyUrl) return options;

  return {
    ...options,
    httpAgentOptions: () => new HttpsProxyAgent(proxyUrl),
  } as T;
}
