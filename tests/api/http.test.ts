import { describe, expect, it, vi } from "vitest";
import { HttpClient } from "@introspection-sdk/introspection-node";
import { IntrospectionAPIError } from "@introspection-sdk/types";

function mockFetch(response: Partial<Response> & { ok: boolean }) {
  const headers = new Headers(
    (response.headers as HeadersInit) ?? { "content-type": "application/json" },
  );
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    headers,
    json: response.json ?? (() => Promise.resolve({})),
    text: response.text ?? (() => Promise.resolve("")),
    arrayBuffer:
      response.arrayBuffer ?? (() => Promise.resolve(new ArrayBuffer(0))),
    body: response.body ?? null,
  });
}

function makeClient(fetchImpl: ReturnType<typeof mockFetch>) {
  return new HttpClient({
    apiUrl: "https://api.example.com",
    token: "test-token",
    fetch: fetchImpl as unknown as typeof fetch,
  });
}

describe("HttpClient", () => {
  it("sends Authorization header with token", async () => {
    const fetchImpl = mockFetch({
      ok: true,
      json: () => Promise.resolve({ id: "1" }),
    });
    const client = makeClient(fetchImpl);
    await client.request({ method: "GET", path: "/v1/things" });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer test-token");
  });

  it("joins base URL and path correctly", async () => {
    const fetchImpl = mockFetch({
      ok: true,
      json: () => Promise.resolve({}),
    });
    const client = makeClient(fetchImpl);
    await client.request({ method: "GET", path: "/v1/tasks" });

    const [url] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/tasks");
  });

  it("strips trailing slashes from base URL", async () => {
    const fetchImpl = mockFetch({
      ok: true,
      json: () => Promise.resolve({}),
    });
    const client = new HttpClient({
      apiUrl: "https://api.example.com///",
      token: "t",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await client.request({ method: "GET", path: "/v1/x" });

    const [url] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/x");
  });

  it("builds query string from params", async () => {
    const fetchImpl = mockFetch({
      ok: true,
      json: () => Promise.resolve({ records: [] }),
    });
    const client = makeClient(fetchImpl);
    await client.request({
      method: "GET",
      path: "/v1/tasks",
      query: { limit: 10, next: "abc" },
    });

    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain("limit=10");
    expect(url).toContain("next=abc");
  });

  it("skips null and undefined query params", async () => {
    const fetchImpl = mockFetch({
      ok: true,
      json: () => Promise.resolve({}),
    });
    const client = makeClient(fetchImpl);
    await client.request({
      method: "GET",
      path: "/v1/tasks",
      query: { a: null, b: undefined, c: "yes" },
    });

    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain("c=yes");
    expect(url).not.toContain("a=");
    expect(url).not.toContain("b=");
  });

  it("expands array query params", async () => {
    const fetchImpl = mockFetch({
      ok: true,
      json: () => Promise.resolve({}),
    });
    const client = makeClient(fetchImpl);
    await client.request({
      method: "GET",
      path: "/v1/tasks",
      query: { statuses: ["running", "pending"] },
    });

    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain("statuses=running");
    expect(url).toContain("statuses=pending");
  });

  it("sends JSON body with content-type header", async () => {
    const fetchImpl = mockFetch({
      ok: true,
      json: () => Promise.resolve({ id: "1" }),
    });
    const client = makeClient(fetchImpl);
    await client.request({
      method: "POST",
      path: "/v1/tasks",
      body: { title: "test" },
    });

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ title: "test" }));
  });

  it("returns parsed JSON by default", async () => {
    const payload = { id: "t1", title: "Test" };
    const fetchImpl = mockFetch({
      ok: true,
      json: () => Promise.resolve(payload),
    });
    const client = makeClient(fetchImpl);
    const result = await client.request({
      method: "GET",
      path: "/v1/tasks/t1",
    });
    expect(result).toEqual(payload);
  });

  it("returns undefined for empty expect", async () => {
    const fetchImpl = mockFetch({ ok: true });
    const client = makeClient(fetchImpl);
    const result = await client.request({
      method: "DELETE",
      path: "/v1/tasks/t1",
      expect: "empty",
    });
    expect(result).toBeUndefined();
  });

  it("returns Uint8Array for bytes expect", async () => {
    const data = new Uint8Array([1, 2, 3]);
    const fetchImpl = mockFetch({
      ok: true,
      arrayBuffer: () => Promise.resolve(data.buffer),
    });
    const client = makeClient(fetchImpl);
    const result = await client.request<Uint8Array>({
      method: "GET",
      path: "/v1/files/f1/content",
      expect: "bytes",
    });
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(3);
  });

  it("returns body stream for stream expect", async () => {
    const body = new ReadableStream();
    const fetchImpl = mockFetch({ ok: true, body });
    const client = makeClient(fetchImpl);
    const result = await client.request({
      method: "GET",
      path: "/v1/stream",
      expect: "stream",
    });
    expect(result).toBe(body);
  });

  it("throws IntrospectionAPIError on non-ok response with JSON detail", async () => {
    const fetchImpl = mockFetch({
      ok: false,
      status: 404,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ detail: "Not found" }),
    });
    const client = makeClient(fetchImpl);
    await expect(
      client.request({ method: "GET", path: "/v1/tasks/missing" }),
    ).rejects.toThrow(IntrospectionAPIError);

    try {
      await client.request({ method: "GET", path: "/v1/tasks/missing" });
    } catch (e) {
      const err = e as IntrospectionAPIError;
      expect(err.status).toBe(404);
      expect(err.message).toBe("Not found");
    }
  });

  it("throws IntrospectionAPIError with text body for non-JSON errors", async () => {
    const fetchImpl = mockFetch({
      ok: false,
      status: 500,
      headers: new Headers({ "content-type": "text/plain" }),
      text: () => Promise.resolve("Internal Server Error"),
    });
    const client = makeClient(fetchImpl);
    await expect(
      client.request({ method: "GET", path: "/v1/x" }),
    ).rejects.toThrow(IntrospectionAPIError);
  });

  it("includes x-request-id in error when present", async () => {
    const fetchImpl = mockFetch({
      ok: false,
      status: 500,
      headers: new Headers({
        "content-type": "application/json",
        "x-request-id": "req-123",
      }),
      json: () => Promise.resolve({ detail: "boom" }),
    });
    const client = makeClient(fetchImpl);
    try {
      await client.request({ method: "GET", path: "/v1/x" });
    } catch (e) {
      expect((e as IntrospectionAPIError).requestId).toBe("req-123");
    }
  });

  it("merges additionalHeaders into requests", async () => {
    const fetchImpl = mockFetch({
      ok: true,
      json: () => Promise.resolve({}),
    });
    const client = new HttpClient({
      apiUrl: "https://api.example.com",
      token: "t",
      additionalHeaders: { "X-Custom": "val" },
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await client.request({ method: "GET", path: "/v1/x" });

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers["X-Custom"]).toBe("val");
  });

  describe("stream()", () => {
    it("sends Accept: text/event-stream header", async () => {
      const fetchImpl = mockFetch({ ok: true, body: new ReadableStream() });
      const client = makeClient(fetchImpl);
      await client.stream({ path: "/v1/tasks/t1/runs/r1/stream" });

      const [, init] = fetchImpl.mock.calls[0];
      expect(init.headers.Accept).toBe("text/event-stream");
    });

    it("throws IntrospectionAPIError on non-ok stream response", async () => {
      const fetchImpl = mockFetch({
        ok: false,
        status: 401,
        headers: new Headers({ "content-type": "text/plain" }),
        text: () => Promise.resolve("Unauthorized"),
      });
      const client = makeClient(fetchImpl);
      await expect(
        client.stream({ path: "/v1/tasks/t1/runs/r1/stream" }),
      ).rejects.toThrow(IntrospectionAPIError);
    });
  });
});
