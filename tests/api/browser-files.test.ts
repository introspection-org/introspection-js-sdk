import { describe, expect, it, vi } from "vitest";
import {
  BrowserHttpClient,
  FilesClient,
  IntrospectionApiClient,
} from "@introspection-sdk/introspection-browser/api";

// Browser Files client unit tests. The DP `fetch`/`http` is injected, so
// no network boundary is crossed (AGENTS.md §6 case 1).

function mockHttp(overrides: Record<string, unknown> = {}) {
  return {
    request: vi.fn().mockResolvedValue(overrides.requestResult ?? {}),
    stream: vi.fn().mockResolvedValue(overrides.streamResult ?? new Response()),
  } as unknown as BrowserHttpClient;
}

const FILE_FIXTURE = {
  id: "file-1",
  name: "notes.txt",
  file_type: "document",
  visibility: "identity",
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
};

describe("browser FilesClient", () => {
  it("list() forwards visibility and task_id filters", async () => {
    const http = mockHttp({
      requestResult: { records: [FILE_FIXTURE], count: 1, next: null },
    });
    const files = new FilesClient(http);
    const page = await files.list({ visibility: "identity", task_id: "task-1" });

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/files",
      query: { visibility: "identity", task_id: "task-1", next: undefined },
    });
    expect(page.records).toHaveLength(1);
  });

  it("list() is a Paginator that auto-pages with for await", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        records: [FILE_FIXTURE],
        count: 1,
        next: "cursor-2",
      })
      .mockResolvedValueOnce({
        records: [{ ...FILE_FIXTURE, id: "file-2" }],
        count: 1,
        next: null,
      });
    const http = { request } as unknown as BrowserHttpClient;
    const files = new FilesClient(http);

    const ids: string[] = [];
    for await (const f of files.list()) ids.push(f.id);

    expect(ids).toEqual(["file-1", "file-2"]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0].query.next).toBe("cursor-2");
  });

  it("get() reads a single file", async () => {
    const http = mockHttp({ requestResult: FILE_FIXTURE });
    const files = new FilesClient(http);
    await files.get("file-1");

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/files/file-1",
    });
  });

  it("upload() posts multipart FormData with credentials transport", async () => {
    const http = mockHttp({ requestResult: FILE_FIXTURE });
    const files = new FilesClient(http);
    await files.upload(
      { file: new Blob(["hi"]), name: "hi.txt" },
      { visibility: "project" },
    );

    const call = (http.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/v1/files");
    expect(call.body).toBeInstanceOf(FormData);
    expect((call.body as FormData).get("visibility")).toBe("project");
  });

  it("createText() folds visibility into the JSON body", async () => {
    const http = mockHttp({ requestResult: FILE_FIXTURE });
    const files = new FilesClient(http);
    await files.createText(
      { name: "n.txt", content: "hello" },
      { visibility: "member" },
    );

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/files",
      body: { name: "n.txt", content: "hello", visibility: "member" },
    });
  });

  it("update() patches a file", async () => {
    const http = mockHttp({ requestResult: FILE_FIXTURE });
    const files = new FilesClient(http);
    await files.update("file-1", { name: "renamed.txt" });

    expect(http.request).toHaveBeenCalledWith({
      method: "PATCH",
      path: "/v1/files/file-1",
      body: { name: "renamed.txt" },
    });
  });

  it("delete() expects an empty response", async () => {
    const http = mockHttp();
    const files = new FilesClient(http);
    await files.delete("file-1");

    expect(http.request).toHaveBeenCalledWith({
      method: "DELETE",
      path: "/v1/files/file-1",
      expect: "empty",
    });
  });

  it("download() requests bytes", async () => {
    const http = mockHttp({ requestResult: new Uint8Array([1, 2, 3]) });
    const files = new FilesClient(http);
    const bytes = await files.download("file-1");

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/files/file-1/content",
      expect: "bytes",
    });
    expect(bytes).toBeInstanceOf(Uint8Array);
  });

  it("versions.list() walks /v1/files/:id/versions", async () => {
    const http = mockHttp({
      requestResult: { records: [FILE_FIXTURE], count: 1, next: null },
    });
    const files = new FilesClient(http);
    await files.versions.list("file-1");

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/files/file-1/versions",
      query: { next: undefined },
    });
  });

  it("is exposed on IntrospectionApiClient.files", () => {
    const client = new IntrospectionApiClient({
      dpUrl: "https://dp.example.com",
      projectId: "proj-1",
      getToken: () => "token",
      fetch: vi.fn() as unknown as typeof fetch,
    });
    expect(client.files).toBeInstanceOf(FilesClient);
  });
});
