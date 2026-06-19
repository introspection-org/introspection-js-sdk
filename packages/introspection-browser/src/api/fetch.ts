/**
 * Resolve the `fetch` implementation for browser Data Plane calls.
 *
 * The native browser `fetch` brand-checks its `this`: it must be the global
 * (`window` / `WorkerGlobalScope`). Storing `globalThis.fetch` on an instance
 * field and later calling it as a method — `this.fetchImpl(url, init)` — rebinds
 * `this` to the client instance, so the browser throws
 * `Failed to execute 'fetch' on 'Window': Illegal invocation`.
 *
 * When no custom `fetch` is supplied we therefore return a thin wrapper that
 * invokes `globalThis.fetch(...)` **as a method of the global** (correct `this`)
 * and resolves it **per call**. The per-call lookup is deliberate: the only
 * reason to go through `globalThis.fetch` rather than the lexical `fetch` is so
 * a swapped-in implementation is honored — that is the server-side proxy
 * (`@introspection-sdk/introspection-proxy` monkeypatches `globalThis.fetch`),
 * never a browser concern. A caller-supplied `fetch` is returned untouched.
 *
 * This lives in the browser package on purpose: Node's `fetch` (undici) has no
 * such brand check, so the shared {@link BaseHttpClient} / Node client keep
 * resolving `globalThis.fetch` directly (so the proxy override still applies).
 */
export function resolveBrowserFetch(custom?: typeof fetch): typeof fetch {
  if (custom) return custom;
  if (!globalThis.fetch) {
    throw new Error(
      "global fetch is unavailable; pass `fetch` or run in a modern browser",
    );
  }
  return (input: RequestInfo | URL, init?: RequestInit) =>
    globalThis.fetch(input, init);
}
