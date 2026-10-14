const FORWARD_PROXY_ENV = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
];

const fetchAtLoad = globalThis.fetch;

/**
 * The fetch REST clients use when the caller supplies none.
 *
 * Node's built-in fetch ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1`,
 * so behind an allowlisting proxy every call failed with "fetch failed". This
 * routes through the forward proxy instead, honouring `NO_PROXY`. Returns
 * `undefined` (use the global fetch) when no proxy is set, when Node already
 * applies it, or inside a sandbox, whose runtime installs its own routing.
 */
export function proxyAwareFetch(): typeof fetch | undefined {
  const env = process.env;
  if (!FORWARD_PROXY_ENV.some((name) => env[name])) return undefined;
  if (env.NODE_USE_ENV_PROXY === "1" || env.INTROSPECTION_EGRESS_URL) {
    return undefined;
  }
  // Loaded on first use, so a process without a proxy never loads undici.
  let proxied: Promise<typeof fetch> | undefined;
  return async (input, init) => {
    // The proxy dispatches through undici directly, so it would bypass a fetch
    // installed after load: a test interceptor, or the caller's own proxy.
    if (globalThis.fetch !== fetchAtLoad) return globalThis.fetch(input, init);
    proxied ??= import("@introspection-sdk/introspection-proxy").then(
      ({ createProxyFetch }) =>
        createProxyFetch({ egressProxyUrl: "", tracing: false }),
    );
    return (await proxied)(input, init);
  };
}
