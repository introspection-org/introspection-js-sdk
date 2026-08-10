/**
 * `error.type` classification.
 *
 * This value is a low-cardinality metric dimension, so a wrong answer is
 * worse than the honest fallback: it splits one bucket into hundreds and
 * mislabels a model-side failure as an HTTP status that never happened.
 * The old pattern was a bare `/\b[45]\d{2}\b/` and matched any three-digit
 * number anywhere in the message.
 */
import { describe, expect, it } from "vitest";
// Internal helper, deliberately not part of the package's public surface --
// imported by path rather than widening the barrel just to test it.
import {
  classifyErrorType,
  classifyThrownErrorType,
} from "../../packages/introspection-pi/src/error-type.js";

describe("classifyErrorType finds a real HTTP status", () => {
  it.each([
    ["429 Too Many Requests", "429"],
    ["Request failed with status code 500", "500"],
    ["HTTP 503: upstream unavailable", "503"],
    ["Error code: 400 - invalid_request_error", "400"],
    ["status=404", "404"],
  ])("reads %j as %s", (message, expected) => {
    expect(classifyErrorType(message, "model_error")).toBe(expected);
  });
});

describe("classifyErrorType does not invent one", () => {
  it.each([
    "context length 512 exceeded",
    "the model returned 500 tokens and stopped",
    "temperature 0.7, max_tokens 401 rejected by policy",
  ])("falls back on %j", (message) => {
    expect(classifyErrorType(message, "model_error")).toBe("model_error");
  });

  it("falls back with no message at all", () => {
    expect(classifyErrorType(undefined, "model_error")).toBe("model_error");
  });
});

describe("classifyThrownErrorType", () => {
  it("prefers a status in the message", () => {
    expect(classifyThrownErrorType(new Error("HTTP 502 from upstream"))).toBe(
      "502",
    );
  });

  it("falls back to the exception class name", () => {
    class RateLimitError extends Error {
      constructor() {
        super("slow down, you sent 600 requests");
        this.name = "RateLimitError";
      }
    }
    // "600" is not a 4xx/5xx, and "requests" is not a status context, so the
    // class name is the honest answer here.
    expect(classifyThrownErrorType(new RateLimitError())).toBe(
      "RateLimitError",
    );
  });

  it("falls back to `exception` for a plain Error", () => {
    expect(classifyThrownErrorType(new Error("boom"))).toBe("exception");
  });

  it("handles a non-Error throw", () => {
    expect(classifyThrownErrorType("just a string")).toBe("exception");
  });
});
