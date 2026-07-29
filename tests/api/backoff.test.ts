import { describe, expect, it } from "vitest";

import {
  backoffMs,
  MAX_BACKOFF_MS,
} from "../../packages/introspection-http/src/backoff.js";

describe("backoffMs", () => {
  it("uses full jitter without Retry-After", () => {
    expect(backoffMs(2, null, 500, () => 0)).toBe(0);
    expect(backoffMs(2, null, 500, () => 0.5)).toBe(1000);
    expect(backoffMs(2, null, 500, () => 1)).toBe(2000);
  });

  it("adds jitter above the Retry-After floor", () => {
    expect(backoffMs(1, 1000, 500, () => 0)).toBe(1000);
    expect(backoffMs(1, 1000, 500, () => 0.5)).toBe(1500);
    expect(backoffMs(1, 1000, 500, () => 1)).toBe(2000);
  });

  it("caps the total delay", () => {
    expect(backoffMs(4, 9000, 1000, () => 1)).toBe(MAX_BACKOFF_MS);
    expect(backoffMs(0, 60000, 500, () => 1)).toBe(MAX_BACKOFF_MS);
  });
});
