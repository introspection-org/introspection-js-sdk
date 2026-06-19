import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserHttpClient,
  IntrospectionApiClient,
} from "@introspection-sdk/introspection-browser/api";

// Regression test for "Failed to execute 'fetch' on 'Window': Illegal
// invocation". The native browser `fetch` brand-checks its `this` (must be the
// global). We simulate that with a `globalThis.fetch` that throws when invoked
// with any other `this`, then exercise the paths that previously called a
// stored `globalThis.fetch` as `this.fetchImpl(...)`:
//   - IntrospectionApiClient.connect()  → DP /v1/oauth/exchange
//   - BrowserHttpClient.request(...)     → cookie-session resource calls
// With the per-call `globalThis.fetch(...)` wrapper both call sites keep the
// correct `this` and no longer throw.

function brandCheckedFetch() {
  const impl = vi.fn(function (this: unknown) {
    if (this !== globalThis) {
      throw new TypeError(
        "Failed to execute 'fetch' on 'Window': Illegal invocation",
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ records: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  return impl;
}

describe("browser fetch binding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("connect() does not throw Illegal invocation with the default fetch", async () => {
    vi.stubGlobal("fetch", brandCheckedFetch());
    const client = new IntrospectionApiClient({
      dpUrl: "https://dp.example.test",
      getToken: () => "tok",
    });
    await expect(client.connect()).resolves.toBeUndefined();
  });

  it("BrowserHttpClient requests do not throw Illegal invocation", async () => {
    vi.stubGlobal("fetch", brandCheckedFetch());
    const http = new BrowserHttpClient({ apiUrl: "https://dp.example.test" });
    await expect(
      http.request({ method: "GET", path: "/v1/conversations" }),
    ).resolves.toEqual({ records: [] });
  });

  it("still throws a friendly error when no fetch is available", () => {
    vi.stubGlobal("fetch", undefined);
    expect(
      () =>
        new IntrospectionApiClient({
          dpUrl: "https://dp.example.test",
          getToken: () => "tok",
        }),
    ).toThrow("global fetch is unavailable");
  });
});
