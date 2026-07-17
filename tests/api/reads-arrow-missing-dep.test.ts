import { describe, expect, it, vi } from "vitest";
import { EventsApi, HttpClient } from "@introspection-sdk/introspection-node";

// Simulate the optional `apache-arrow` peer dependency being absent: the
// dynamic `import("apache-arrow")` inside `fetchArrowPage` rejects, and the
// catch must rethrow a clear, actionable install message. This lives in its
// own file so the throwing module mock is isolated from the tests that build
// real IPC streams. The mock factory throwing rejects the dynamic import.
vi.mock("apache-arrow", () => {
  throw new Error("Cannot find module 'apache-arrow'");
});

function mockHttp(overrides: Record<string, unknown> = {}) {
  return {
    request: vi.fn().mockResolvedValue(overrides.requestResult ?? {}),
    stream: vi.fn().mockResolvedValue(overrides.streamResult ?? new Response()),
  } as unknown as HttpClient;
}

describe("EventsApi.list — Arrow format without apache-arrow installed", () => {
  it("throws a clear 'install apache-arrow' error when the dynamic import fails", async () => {
    // A non-empty body forces the `bytes.byteLength > 0` branch, so the
    // decode path attempts to import the (mocked, throwing) module.
    const http = mockHttp({
      streamResult: new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "x-result-count": "1", "x-truncated": "false" },
      }),
    });
    const api = new EventsApi(http);

    // The rethrown error must name the peer dep and how to install it.
    await expect(api.list({ format: "arrow" })).rejects.toThrow(
      /requires the optional 'apache-arrow'.*npm install apache-arrow/s,
    );
  });
});
