/**
 * Coverage for the integration-discovery error classifier — distinguishing
 * "framework package not installed" (expected, skip quietly) from a real error
 * inside an installed integration (surfaced at warn). Pure logic, no mocks.
 */
import { describe, expect, it } from "vitest";

import { isModuleNotFound } from "../../packages/introspection-node/src/otel/integrations/index";

describe("isModuleNotFound", () => {
  it("treats absent peer packages as module-not-found", () => {
    expect(isModuleNotFound({ code: "ERR_MODULE_NOT_FOUND" })).toBe(true);
    expect(isModuleNotFound({ code: "MODULE_NOT_FOUND" })).toBe(true);
    expect(
      isModuleNotFound(new Error("Cannot find module '@mastra/core'")),
    ).toBe(true);
    expect(
      isModuleNotFound(new Error("Cannot find package 'ai' imported from x")),
    ).toBe(true);
    expect(
      isModuleNotFound(new Error("Failed to resolve '@openai/agents'")),
    ).toBe(true);
  });

  it("treats real integration errors as NOT module-not-found", () => {
    expect(isModuleNotFound(new Error("boom: bad config"))).toBe(false);
    expect(isModuleNotFound(new TypeError("x is not a function"))).toBe(false);
    expect(isModuleNotFound({ code: "ERR_SOMETHING_ELSE" })).toBe(false);
    expect(isModuleNotFound("plain string error")).toBe(false);
    expect(isModuleNotFound(null)).toBe(false);
  });
});
