import { afterEach, describe, expect, it, vi } from "vitest";
import {
  serviceAccountToken,
  tokenExchange,
} from "@introspection-sdk/introspection-node";

// Unit coverage for the auth helpers' resolveBaseApiUrl / resolveFetch
// fallbacks. The real-server suite always passes an explicit `baseApiUrl`
// and `fetch`, so the `?? env`, `?? default`, `?? globalThis.fetch`, and
// "no fetch available" branches are only reachable here, where we omit
// those params and drive the global instead.

function captureFetch() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve({ access_token: "t", expires_in: 1 }),
  });
}

function requestedUrl(fetchImpl: ReturnType<typeof captureFetch>): string {
  return String(fetchImpl.mock.calls[0][0]);
}

const CREDS = {
  clientId: "intro_app_1",
  clientSecret: "intro_sk_1",
  project: "proj-1",
};

describe("auth helpers — base URL / fetch resolution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("falls back to globalThis.fetch and the public default base URL", async () => {
    // Unset (not empty): `resolveBaseApiUrl` uses `??`, so only a nullish
    // env var falls through to the default.
    vi.stubEnv("INTROSPECTION_BASE_API_URL", undefined);
    const fetchImpl = captureFetch();
    vi.stubGlobal("fetch", fetchImpl);

    await serviceAccountToken(CREDS); // no baseApiUrl, no fetch

    expect(requestedUrl(fetchImpl)).toBe(
      "https://api.introspection.dev/v1/oauth/token",
    );
  });

  it("falls back to INTROSPECTION_BASE_API_URL when no baseApiUrl is given", async () => {
    vi.stubEnv("INTROSPECTION_BASE_API_URL", "https://cp.env.test");
    const fetchImpl = captureFetch();
    vi.stubGlobal("fetch", fetchImpl);

    await serviceAccountToken(CREDS);

    expect(requestedUrl(fetchImpl)).toBe("https://cp.env.test/v1/oauth/token");
  });

  it("throws a helpful error when no fetch is available", async () => {
    vi.stubGlobal("fetch", undefined);

    await expect(serviceAccountToken(CREDS)).rejects.toThrow(
      "global fetch is unavailable",
    );
  });

  it("includes an explicit scope in the token-exchange form", async () => {
    const fetchImpl = captureFetch();
    vi.stubGlobal("fetch", fetchImpl);

    await tokenExchange({
      subjectToken: "partner-id-token",
      clientId: "intro_app_fed",
      project: "proj-1",
      scope: "runtimes:run files:read",
    });

    const [, init] = fetchImpl.mock.calls[0];
    expect(String(init.body)).toContain("scope=runtimes%3Arun");
  });
});
