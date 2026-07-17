import { afterEach, describe, expect, it, vi } from "vitest";
import { IntrospectionClient } from "@introspection-sdk/introspection-node";

// Unit coverage for the IntrospectionClient constructor's credential /
// base-URL resolution (token → env → "", advanced → {}, baseApiUrl →
// env → default). A captured `fetch` (the same injection point the SDK
// exposes for non-Node runtimes) lets us assert the resolved base URL and
// Authorization header without a live server.

function captureFetch() {
  return vi.fn().mockImplementation((input: string | URL | Request) => {
    const url = String(input);
    const payload = url.includes("/v1/runtimes?")
      ? {
          records: [{ id: "11111111-1111-1111-1111-111111111111" }],
          count: 1,
          total_count: 1,
          next: null,
        }
      : {
          session_id: "session-1",
          deployment: {
            endpoint: "https://dp.test",
            slug: "test",
            region: "test",
          },
          session_token: "runner-token",
          expires_at: "2026-01-01T00:00:00Z",
          runtime_context: { identity: {} },
        };
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve(payload),
      text: () => Promise.resolve(JSON.stringify(payload)),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      body: null,
    });
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

  it("does not expose its Control Plane transport", () => {
    const client = new IntrospectionClient({ token: "tok" });
    expect(client).not.toHaveProperty("cpHttp");
    expect(client).not.toHaveProperty("advancedOptions");
  });

  it("uses an explicit token and advanced.baseApiUrl", async () => {
    const fetchImpl = captureFetch();
    const client = new IntrospectionClient({
      token: "explicit-token",
      advanced: { baseApiUrl: "https://cp.explicit.test", fetch: fetchImpl },
    });

    await client.runtime("agent").run();

    expect(requestedUrl(fetchImpl)).toContain("https://cp.explicit.test");
    expect(authHeader(fetchImpl)).toBe("Bearer explicit-token");
  });

  it("falls back to INTROSPECTION_TOKEN / INTROSPECTION_BASE_API_URL env", async () => {
    vi.stubEnv("INTROSPECTION_TOKEN", "env-token");
    vi.stubEnv("INTROSPECTION_BASE_API_URL", "https://cp.env.test");
    const fetchImpl = captureFetch();
    const client = new IntrospectionClient({ advanced: { fetch: fetchImpl } });

    await client.runtime("agent").run();

    expect(requestedUrl(fetchImpl)).toContain("https://cp.env.test");
    expect(authHeader(fetchImpl)).toBe("Bearer env-token");
  });

  it("falls back to the public default base URL with an empty token", async () => {
    vi.stubEnv("INTROSPECTION_TOKEN", "");
    vi.stubEnv("INTROSPECTION_BASE_API_URL", "");
    const fetchImpl = captureFetch();
    const client = new IntrospectionClient({ advanced: { fetch: fetchImpl } });

    await client.runtime("agent").run();

    expect(requestedUrl(fetchImpl)).toContain("https://api.introspection.dev");
    // No token resolved — the warn branch fires and an empty bearer is sent.
    expect(authHeader(fetchImpl)).toBe("Bearer ");
  });
});
