/** @introspection-sdk/aauth-protocol's budget parser and https-only fetch. */
import { httpsOnly, parseBudget } from "@introspection-sdk/aauth-protocol";
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
