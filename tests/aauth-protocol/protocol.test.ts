/** @introspection-sdk/aauth-protocol's budget parser and https-only fetch. */
import {
  authGrant,
  httpsOnly,
  loadSigner,
  MAX_TOKEN_LIFETIME,
  parseBudget,
  readJsonObject,
  readProposalSummary,
  signatureError,
  tokenProblem,
  trimIdentifier,
} from "@introspection-sdk/aauth-protocol";
import { describe, expect, it } from "vitest";

describe("@introspection-sdk/aauth-protocol", () => {
  it("reads a budget, and refuses anything that is not a non-negative integer amount", () => {
    expect(parseBudget(undefined)).toBeUndefined();
    expect(parseBudget({ amount: 0, unit: "USD", decimals: 2 })).toEqual({
      amount: 0,
      unit: "USD",
      decimals: 2,
    });
    for (const bad of [
      { amount: -1, unit: "USD", decimals: 2 },
      { amount: 1.5, unit: "USD", decimals: 2 },
      { amount: Number.MAX_SAFE_INTEGER + 1, unit: "USD", decimals: 2 },
      { amount: 1, unit: "", decimals: 2 },
      { amount: 1, unit: "USD", decimals: -1 },
      { amount: "1", unit: "USD", decimals: 2 },
      "1 USD",
    ])
      expect(() => parseBudget(bad)).toThrow(/budget/);
  });

  it("calls only https, and never follows a redirect", async () => {
    const seen: (RequestInit | undefined)[] = [];
    const guarded = httpsOnly(async (_input, init) => {
      seen.push(init);
      return new Response("{}");
    });
    await expect(guarded("http://as.example/token")).rejects.toThrow(/https/);
    await expect(guarded("not a url")).rejects.toThrow(/URL/);
    expect(seen).toHaveLength(0);
    await guarded("https://as.example/token", { method: "POST" });
    expect(seen[0]).toMatchObject({ method: "POST", redirect: "error" });
  });
});

describe("readProposalSummary", () => {
  it("reads a proposal only from the resource's own https origin", async () => {
    const signer = await loadSigner(undefined, "ps-1");
    const fetched: string[] = [];
    const reader = {
      issuer: "https://ps.example",
      dwk: "aauth-person.json",
      signer,
      fetch: async (input: string) => {
        fetched.push(input);
        return new Response("{}");
      },
    };
    for (const r3_uri of [
      "https://internal.cluster.local/r3/1",
      "http://booking.example/r3/1",
      "https://user:pass@booking.example/r3/1",
      "https://10.0.0.5/r3/1",
    ])
      expect(
        await readProposalSummary(
          { iss: "https://booking.example", r3_uri, r3_s256: "x" },
          reader,
        ),
      ).toBeUndefined();
    expect(fetched).toHaveLength(0);
  });
});

describe("token shapes", () => {
  const sound = { jti: "1", dwk: "aauth-person.json", iat: 0, exp: 3600 };

  it("takes a token with a jti, its dwk, and a lifetime within the bound", () => {
    expect(
      tokenProblem(sound, {
        dwk: "aauth-person.json",
        maxLifetime: MAX_TOKEN_LIFETIME,
      }),
    ).toBeUndefined();
    expect(tokenProblem({ jti: "1", iat: 0, exp: 86_400 }, {})).toBeUndefined();
  });

  it("names what is wrong with one that is not", () => {
    const expected = {
      dwk: "aauth-person.json",
      maxLifetime: MAX_TOKEN_LIFETIME,
    };
    expect(tokenProblem({ ...sound, jti: undefined }, expected)).toBe(
      "has no jti",
    );
    expect(tokenProblem({ ...sound, jti: "" }, expected)).toBe("has no jti");
    expect(tokenProblem({ ...sound, dwk: "aauth-agent.json" }, expected)).toBe(
      "has a dwk other than aauth-person.json",
    );
    expect(tokenProblem({ ...sound, exp: 3601 }, expected)).toBe(
      "lives longer than 3600 seconds",
    );
    expect(tokenProblem({ ...sound, iat: undefined }, expected)).toBe(
      "has no iat or exp",
    );
  });

  it("compares identifiers without a trailing slash", () => {
    expect(trimIdentifier("https://as.example/")).toBe("https://as.example");
    expect(trimIdentifier("https://as.example//")).toBe("https://as.example");
    expect(trimIdentifier("https://as.example")).toBe("https://as.example");
  });

  it("copies only the string claims an auth token carries from the resource token", () => {
    expect(
      authGrant(
        {
          sub: "s",
          scope: "a b",
          account: "acct-7",
          r3_uri: "https://r.example/r3/1",
          r3_s256: 5,
          agent_jkt: "j",
        },
        "https://r.example",
        { amount: 1, unit: "USD", decimals: 2 },
      ),
    ).toEqual({
      aud: "https://r.example",
      sub: "s",
      scope: "a b",
      account: "acct-7",
      r3_uri: "https://r.example/r3/1",
      budget: { amount: 1, unit: "USD", decimals: 2 },
    });
  });
});

describe("request bodies and signature errors", () => {
  it("reads a JSON object, and refuses anything else", () => {
    expect(readJsonObject('{"a":1}')).toEqual({ a: 1 });
    for (const body of ["[]", "1", '"a"', "null", "not json", ""])
      expect(() => readJsonObject(body)).toThrow(/JSON object/);
  });

  it("answers an unsupported scheme with the scheme it accepts", () => {
    const err = signatureError("unsupported_scheme", "sign with sig=jwt");
    expect(err.status).toBe(401);
    expect(err.headers["Signature-Error"]).toContain("unsupported_scheme");
    expect(err.headers["Accept-Signature-Scheme"]).toContain("jwt");
  });
});
