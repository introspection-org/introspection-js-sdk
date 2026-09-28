import { describe, expect, it, vi } from "vitest";
import { BrowsersApi, HttpClient } from "@introspection-sdk/introspection-node";

function mockHttp(result: unknown = {}) {
  return {
    request: vi.fn().mockResolvedValue(result),
    stream: vi.fn(),
  } as unknown as HttpClient;
}

const BROWSER = {
  id: "b-1",
  session_id: "b-1",
  org_id: "org-1",
  project_id: "proj-1",
  created_at: "2026-09-25T00:00:00Z",
  updated_at: "2026-09-25T00:00:00Z",
  status: "ready" as const,
  cdp_ws_url: "wss://browser.dp.test/v1/browsers/b-1/cdp",
  headless: true,
  timeout_seconds: 600,
  allowed_domains: ["app.example.com"],
};

describe("BrowsersApi", () => {
  it("list() pages GET /v1/browsers with filters", async () => {
    const http = mockHttp({
      records: [BROWSER],
      count: 1,
      total_count: 1,
      next: null,
    });
    const out = [];
    for await (const b of new BrowsersApi(http).list({
      status: "ready",
      limit: 5,
    }))
      out.push(b);
    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/browsers",
      query: { status: "ready", limit: 5 },
    });
    expect(out).toEqual([BROWSER]);
  });

  it("create() POSTs, defaulting to an empty body", async () => {
    const http = mockHttp(BROWSER);
    const api = new BrowsersApi(http);
    expect(
      await api.create({
        allowed_domains: ["app.example.com"],
        profile: "work",
      }),
    ).toEqual(BROWSER);
    expect(http.request).toHaveBeenLastCalledWith({
      method: "POST",
      path: "/v1/browsers",
      body: { allowed_domains: ["app.example.com"], profile: "work" },
    });
    await api.create();
    expect(http.request).toHaveBeenLastCalledWith({
      method: "POST",
      path: "/v1/browsers",
      body: {},
    });
  });

  it("get(), update() and delete() address one browser by encoded id", async () => {
    const http = mockHttp(BROWSER);
    const api = new BrowsersApi(http);
    await api.get("b/1");
    expect(http.request).toHaveBeenLastCalledWith({
      method: "GET",
      path: "/v1/browsers/b%2F1",
    });
    await api.update("b-1", { timeout_seconds: 900 });
    expect(http.request).toHaveBeenLastCalledWith({
      method: "PATCH",
      path: "/v1/browsers/b-1",
      body: { timeout_seconds: 900 },
    });
    await api.delete("b-1");
    expect(http.request).toHaveBeenLastCalledWith({
      method: "DELETE",
      path: "/v1/browsers/b-1",
      expect: "empty",
    });
  });
});
