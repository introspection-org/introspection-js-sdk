import { afterEach, describe, expect, it, vi } from "vitest";
import { IntrospectionClient } from "@introspection-sdk/introspection-node";

// Unit coverage for the IntrospectionClient constructor's credential /
// base-URL resolution (token → env → "", advanced → {}, baseApiUrl →
// env → default). A captured `fetch` (the same injection point the SDK
// exposes for non-Node runtimes) lets us assert the resolved base URL and
// Authorization header without a live server.

function captureFetch() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(""),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    body: null,
  });
}

function requestedUrl(fetchImpl: ReturnType<typeof captureFetch>): string {
  return String(fetchImpl.mock.calls[0][0]);
}

function authHeader(fetchImpl: ReturnType<typeof captureFetch>): string {
  const [, init] = fetchImpl.mock.calls[0];
  return (init.headers as Record<string, string>).Authorization;
}

describe("IntrospectionClient construction", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults advanced to the SDK's own headers and nothing else", () => {
    const client = new IntrospectionClient({ token: "tok" });
    // `additionalHeaders` is always populated now: the client identifies the
    // SDK and its release on every REST call, and the Runner's Data-Plane
    // client inherits the set from here.
    expect(client.advancedOptions).toEqual({
      additionalHeaders: {
        "User-Agent": expect.stringMatching(
          /^introspection-sdk\/\d+\.\d+\.\d+/,
        ),
      },
    });
  });

  it("uses an explicit token and advanced.baseApiUrl", async () => {
    const fetchImpl = captureFetch();
    const client = new IntrospectionClient({
      token: "explicit-token",
      advanced: { baseApiUrl: "https://cp.explicit.test", fetch: fetchImpl },
    });

    await client.cpHttp.request({ method: "GET", path: "/v1/runtimes" });

    expect(requestedUrl(fetchImpl)).toContain("https://cp.explicit.test");
    expect(authHeader(fetchImpl)).toBe("Bearer explicit-token");
  });

  it("falls back to INTROSPECTION_TOKEN / INTROSPECTION_BASE_API_URL env", async () => {
    vi.stubEnv("INTROSPECTION_TOKEN", "env-token");
    vi.stubEnv("INTROSPECTION_BASE_API_URL", "https://cp.env.test");
    const fetchImpl = captureFetch();
    const client = new IntrospectionClient({ advanced: { fetch: fetchImpl } });

    await client.cpHttp.request({ method: "GET", path: "/v1/runtimes" });

    expect(requestedUrl(fetchImpl)).toContain("https://cp.env.test");
    expect(authHeader(fetchImpl)).toBe("Bearer env-token");
  });

  it("falls back to the public default base URL with an empty token", async () => {
    vi.stubEnv("INTROSPECTION_TOKEN", "");
    vi.stubEnv("INTROSPECTION_BASE_API_URL", "");
    const fetchImpl = captureFetch();
    const client = new IntrospectionClient({ advanced: { fetch: fetchImpl } });

    await client.cpHttp.request({ method: "GET", path: "/v1/runtimes" });

    expect(requestedUrl(fetchImpl)).toContain("https://api.introspection.dev");
    // No token resolved — the warn branch fires and an empty bearer is sent.
    expect(authHeader(fetchImpl)).toBe("Bearer ");
  });
});
