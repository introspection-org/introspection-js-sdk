import type { ProxyFetchOptions } from "./proxy.js";

export interface LazyProxyFetchInstallation {
  /** Load and initialize the proxy engine. Concurrent calls share one promise. */
  ready(): Promise<typeof fetch>;
  /** Restore the fetch implementation that was active before installation. */
  restore(): void;
}

/**
 * Install a proxy-enforcing fetch guard without loading Undici eagerly.
 *
 * The guard is installed synchronously, so outbound requests cannot race proxy
 * initialization. The first request waits for the real proxy implementation;
 * callers that own process startup can invoke `ready()` after their listener is
 * bound to overlap initialization with the rest of application bootstrap.
 */
export function installLazyProxyFetch(
  options: ProxyFetchOptions = {},
): LazyProxyFetchInstallation {
  const original = globalThis.fetch;
  let proxyPromise: Promise<typeof fetch> | undefined;

  const ready = (): Promise<typeof fetch> => {
    proxyPromise ??= import("./proxy.js").then(({ createProxyFetchWithBase }) =>
      createProxyFetchWithBase(options, original),
    );
    return proxyPromise;
  };

  const guardedFetch: typeof fetch = async (input, init) => {
    const proxiedFetch = await ready();
    return proxiedFetch(input, init);
  };

  globalThis.fetch = guardedFetch;

  return {
    ready,
    restore() {
      if (globalThis.fetch === guardedFetch) {
        globalThis.fetch = original;
      }
    },
  };
}
