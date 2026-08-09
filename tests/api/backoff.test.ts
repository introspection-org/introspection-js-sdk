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

  it("caps the jitter it adds, not the server's floor", () => {
    // Only the SDK's own exponential/jitter component is bounded.
    expect(backoffMs(4, 0, 1000, () => 1)).toBe(MAX_BACKOFF_MS);
    expect(backoffMs(4, 9000, 1000, () => 1)).toBe(9000 + MAX_BACKOFF_MS);
  });

  it("honours a Retry-After longer than the cap", () => {
    // `Retry-After: 60` used to be clamped to 10s, so the SDK re-hit the
    // rate limiter 50s before the server said it could.
    expect(backoffMs(0, 60000, 500, () => 0)).toBe(60000);
    expect(backoffMs(0, 60000, 500, () => 1)).toBe(60500);
  });
});
