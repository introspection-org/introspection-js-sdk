import { describe, expect, it, vi } from "vitest";
import { EventsApi, HttpClient } from "@introspection-sdk/introspection-node";

// Simulate the optional `apache-arrow` peer dependency being absent: the
// dynamic `import("apache-arrow")` inside `loadArrow()` (reads.ts) rejects,
// and the catch must rethrow a clear, actionable install message from BOTH
// Arrow consumers — the row-oriented `format: "arrow"` list decode and the
// columnar `.arrow()` accessor. This lives in its own file so the throwing
// module mock is isolated from the tests that build real IPC streams. The
// mock factory throwing rejects the dynamic import.
vi.mock("apache-arrow", () => {
  throw new Error("Cannot find module 'apache-arrow'");
});

const INSTALL_MESSAGE =
  /requires the optional 'apache-arrow'.*npm install apache-arrow/s;

function mockHttp(overrides: Record<string, unknown> = {}) {
  return {
    request: vi.fn().mockResolvedValue(overrides.requestResult ?? {}),
    stream: vi.fn().mockResolvedValue(overrides.streamResult ?? new Response()),
  } as unknown as HttpClient;
}

describe("Arrow reads without apache-arrow installed", () => {
  it("list({ format: 'arrow' }) throws a clear 'install apache-arrow' error", async () => {
    // A non-empty body forces the `bytes.byteLength > 0` branch, so the
    // decode path attempts to import the (mocked, throwing) module.
    const http = mockHttp({
      streamResult: new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "x-result-count": "1", "x-truncated": "false" },
      }),
    });
    const api = new EventsApi(http);

    // The rethrown error must name the peer dep and how to install it.
    await expect(
      api.list({ event_name: "introspection.feedback", format: "arrow" }),
    ).rejects.toThrow(INSTALL_MESSAGE);
  });

  it("arrow() page iteration throws the same error from the per-page decode", async () => {
    const http = mockHttp({
      streamResult: new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "x-result-count": "1" },
      }),
    });
    const api = new EventsApi(http);

    const iterate = async () => {
      for await (const table of api.arrow({
        event_name: "introspection.feedback",
      })) {
        void table;
      }
    };
    await expect(iterate()).rejects.toThrow(INSTALL_MESSAGE);
  });

  it("arrow().readAll() throws the same error before any page is fetched", async () => {
    const http = mockHttp();
    const api = new EventsApi(http);

    await expect(
      api.arrow({ event_name: "introspection.feedback" }).readAll(),
    ).rejects.toThrow(INSTALL_MESSAGE);
  });
});
