import { describe, expect, it } from "vitest";
import { IntrospectionAPIError } from "@introspection-sdk/types";

describe("IntrospectionAPIError", () => {
  it("sets all provided fields", () => {
    const err = new IntrospectionAPIError({
      message: "Not found",
      status: 404,
      code: "not_found",
      requestId: "req-abc",
      body: { detail: "Not found" },
    });

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("IntrospectionAPIError");
    expect(err.message).toBe("Not found");
    expect(err.status).toBe(404);
    expect(err.code).toBe("not_found");
    expect(err.requestId).toBe("req-abc");
    expect(err.body).toEqual({ detail: "Not found" });
  });

  it("defaults code and requestId to null", () => {
    const err = new IntrospectionAPIError({
      message: "Server error",
      status: 500,
    });

    expect(err.code).toBeNull();
    expect(err.requestId).toBeNull();
    expect(err.body).toBeUndefined();
  });

  it("is throwable and catchable", () => {
    const err = new IntrospectionAPIError({
      message: "Forbidden",
      status: 403,
    });

    expect(() => {
      throw err;
    }).toThrow("Forbidden");
  });
});
