import { describe, expect, it, vi } from "vitest";
import {
  HttpClient,
  FilesApi,
  FileVersionsApi,
} from "@introspection-sdk/introspection-node";

function mockHttp(overrides: Record<string, unknown> = {}) {
  return {
    request: vi.fn().mockResolvedValue(overrides.requestResult ?? {}),
    stream: vi.fn().mockResolvedValue(overrides.streamResult ?? new Response()),
  } as unknown as HttpClient;
}

const FILE_FIXTURE = {
  id: "file-1",
  org_id: "org-1",
  project_id: "proj-1",
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
  name: "test.txt",
  file_type: "upload" as const,
  storage_path: "/files/test.txt",
  mime_type: "text/plain",
  size_bytes: 100,
  version: 1,
};

describe("FilesApi", () => {
  it("list() calls GET /v1/files", async () => {
    const http = mockHttp({
      requestResult: {
        records: [FILE_FIXTURE],
        count: 1,
        total_count: 1,
        next: null,
      },
    });
    const api = new FilesApi(http);
    const files = [];
    for await (const f of api.list({ limit: 5 })) files.push(f);

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/files",
      query: { limit: 5 },
    });
    expect(files).toHaveLength(1);
  });

  it("list() paginates through all pages", async () => {
    const page1 = {
      records: [FILE_FIXTURE],
      count: 1,
      total_count: 2,
      next: "cur2",
    };
    const page2 = {
      records: [{ ...FILE_FIXTURE, id: "file-2" }],
      count: 1,
      total_count: 2,
      next: null,
    };
    const http = mockHttp();
    (http.request as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);

    const api = new FilesApi(http);
    const files = [];
    for await (const f of api.list()) files.push(f);

    expect(files).toHaveLength(2);
    expect(http.request).toHaveBeenCalledTimes(2);
  });

  it("upload() sends FormData via POST /v1/files", async () => {
    const http = mockHttp({ requestResult: FILE_FIXTURE });
    const api = new FilesApi(http);
    const blob = new Blob(["hello"], { type: "text/plain" });
    await api.upload({ file: blob, name: "test.txt" });

    expect(http.request).toHaveBeenCalledOnce();
    const call = (http.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/v1/files");
    expect(call.body).toBeInstanceOf(FormData);
  });

  it("upload() handles Uint8Array file body", async () => {
    const http = mockHttp({ requestResult: FILE_FIXTURE });
    const api = new FilesApi(http);
    const data = new Uint8Array([1, 2, 3]);
    await api.upload({ file: data, name: "binary.bin" });

    const call = (http.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.body).toBeInstanceOf(FormData);
    const fd = call.body as FormData;
    expect(fd.get("name")).toBe("binary.bin");
  });

  it("createText() calls POST /v1/files with JSON body", async () => {
    const http = mockHttp({ requestResult: FILE_FIXTURE });
    const api = new FilesApi(http);
    await api.createText({ name: "readme.md", content: "# Hello" });

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/files",
      body: { name: "readme.md", content: "# Hello" },
    });
  });

  it("createText() includes mime_type in the JSON body", async () => {
    const http = mockHttp({ requestResult: FILE_FIXTURE });
    const api = new FilesApi(http);
    await api.createText({
      name: "notes.md",
      content: "# Hello",
      mime_type: "text/markdown",
    });

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/files",
      body: {
        name: "notes.md",
        content: "# Hello",
        mime_type: "text/markdown",
      },
    });
  });

  it("upload() posts multipart FormData", async () => {
    const http = mockHttp({ requestResult: FILE_FIXTURE });
    const api = new FilesApi(http);
    await api.upload({ file: new Blob(["hi"]), name: "hi.txt" });

    const call = (http.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.body).toBeInstanceOf(FormData);
    expect((call.body as FormData).get("name")).toBe("hi.txt");
  });

  it("list() forwards the task_id filter", async () => {
    const http = mockHttp({
      requestResult: { records: [], count: 0, total_count: 0, next: null },
    });
    const api = new FilesApi(http);
    await api.list({ task_id: "task-1" });

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/files",
      query: { task_id: "task-1" },
    });
  });

  it("get() calls GET /v1/files/:id", async () => {
    const http = mockHttp({ requestResult: FILE_FIXTURE });
    const api = new FilesApi(http);
    await api.get("file-1");

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/files/file-1",
    });
  });

  it("update() calls PATCH /v1/files/:id", async () => {
    const http = mockHttp({ requestResult: FILE_FIXTURE });
    const api = new FilesApi(http);
    await api.update("file-1", { name: "renamed.txt" });

    expect(http.request).toHaveBeenCalledWith({
      method: "PATCH",
      path: "/v1/files/file-1",
      body: { name: "renamed.txt" },
    });
  });

  it("delete() calls DELETE /v1/files/:id", async () => {
    const http = mockHttp();
    const api = new FilesApi(http);
    await api.delete("file-1");

    expect(http.request).toHaveBeenCalledWith({
      method: "DELETE",
      path: "/v1/files/file-1",
      expect: "empty",
    });
  });

  it("download() calls GET /v1/files/:id/content with bytes expect", async () => {
    const http = mockHttp({ requestResult: new Uint8Array([1, 2]) });
    const api = new FilesApi(http);
    await api.download("file-1");

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/files/file-1/content",
      expect: "bytes",
    });
  });

  it("downloadStream() calls GET /v1/files/:id/content with stream expect", async () => {
    const http = mockHttp({ requestResult: new ReadableStream() });
    const api = new FilesApi(http);
    await api.downloadStream("file-1");

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/files/file-1/content",
      expect: "stream",
    });
  });

  it("URL-encodes file IDs", async () => {
    const http = mockHttp({ requestResult: FILE_FIXTURE });
    const api = new FilesApi(http);
    await api.get("file/special id");

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/files/file%2Fspecial%20id",
    });
  });
});

describe("FileVersionsApi", () => {
  it("list() calls GET /v1/files/:id/versions", async () => {
    const http = mockHttp({
      requestResult: {
        records: [FILE_FIXTURE],
        count: 1,
        total_count: 1,
        next: null,
      },
    });
    const versions = new FileVersionsApi(http);
    const all = [];
    for await (const v of versions.list("file-1")) all.push(v);

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/files/file-1/versions",
      query: {},
    });
    expect(all).toHaveLength(1);
  });

  it("list() paginates through versions", async () => {
    const page1 = {
      records: [FILE_FIXTURE],
      count: 1,
      total_count: 2,
      next: "v2",
    };
    const page2 = {
      records: [{ ...FILE_FIXTURE, version: 2 }],
      count: 1,
      total_count: 2,
      next: null,
    };
    const http = mockHttp();
    (http.request as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);

    const versions = new FileVersionsApi(http);
    const all = [];
    for await (const v of versions.list("file-1")) all.push(v);
    expect(all).toHaveLength(2);
  });

  it("get() calls GET /v1/files/:fileId/versions/:versionId", async () => {
    const http = mockHttp({ requestResult: FILE_FIXTURE });
    const versions = new FileVersionsApi(http);
    await versions.get("file-1", "ver-1");

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/files/file-1/versions/ver-1",
    });
  });

  it("create() sends FormData via POST /v1/files/:id/versions", async () => {
    const http = mockHttp({ requestResult: FILE_FIXTURE });
    const versions = new FileVersionsApi(http);
    const blob = new Blob(["v2 content"], { type: "text/plain" });
    await versions.create("file-1", { file: blob, name: "test.txt" });

    const call = (http.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/v1/files/file-1/versions");
    expect(call.body).toBeInstanceOf(FormData);
  });
});
