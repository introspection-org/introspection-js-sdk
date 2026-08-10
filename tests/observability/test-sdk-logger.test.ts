/**
 * The SDK's own diagnostic logger.
 *
 * These methods write straight to `console`, so the default level decides
 * whether importing this library prints onto an application's stdout. It
 * used to default to INFO, and constructing a client or a span processor
 * emitted an unsolicited line. A library should be quiet unless asked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV = process.env.INTROSPECTION_LOG_LEVEL;

beforeEach(() => {
  vi.resetModules();
  delete process.env.INTROSPECTION_LOG_LEVEL;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ENV === undefined) delete process.env.INTROSPECTION_LOG_LEVEL;
  else process.env.INTROSPECTION_LOG_LEVEL = ENV;
});

async function freshLogger() {
  return (await import("../../packages/introspection-node/src/utils.js"))
    .logger;
}

describe("the SDK's diagnostic logger", () => {
  it("says nothing at info level by default", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    (await freshLogger()).info("initialized: endpoint=…");
    expect(info).not.toHaveBeenCalled();
  });

  it("still reports warnings and errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = await freshLogger();
    logger.warn("No token provided. Events will not be sent.");
    logger.error("export failed");
    expect(warn).toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it("turns info back on when asked", async () => {
    process.env.INTROSPECTION_LOG_LEVEL = "info";
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    (await freshLogger()).info("initialized: endpoint=…");
    expect(info).toHaveBeenCalled();
  });

  it("falls back to the quiet default for an unrecognised level", async () => {
    process.env.INTROSPECTION_LOG_LEVEL = "chatty";
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = await freshLogger();
    logger.info("x");
    logger.warn("y");
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});
