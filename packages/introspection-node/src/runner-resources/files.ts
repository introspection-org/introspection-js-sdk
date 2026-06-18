import type {
  File as FileResource,
  FileCreateTextParams,
  FileListParams,
  FileType,
  FileUpdateParams,
  ListParams,
  Paginated,
} from "@introspection-sdk/types";
import { HttpClient } from "../http.js";
import { Paginator, cursorPaginate } from "../pagination.js";

export type FileUploadBody =
  | { file: Blob; name?: string; file_type?: FileType }
  | {
      file: Uint8Array;
      name: string;
      file_type?: FileType;
      contentType?: string;
    };

export class FileVersionsApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * List versions of a file. `await` the result for the first page, or
   * `for await` it to stream every version across pages (fetched lazily;
   * stop early to stop fetching).
   */
  list(fileId: string, params?: ListParams): Paginator<FileResource> {
    return cursorPaginate(
      (next) =>
        this.http.request<Paginated<FileResource>>({
          method: "GET",
          path: `/v1/files/${encodeURIComponent(fileId)}/versions`,
          query: { ...params, next } as Record<string, unknown>,
        }),
      params?.next,
    );
  }

  get(fileId: string, versionId: string): Promise<FileResource> {
    return this.http.request<FileResource>({
      method: "GET",
      path: `/v1/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}`,
    });
  }

  create(fileId: string, body: FileUploadBody): Promise<FileResource> {
    const form = toFormData(body);
    return this.http.request<FileResource>({
      method: "POST",
      path: `/v1/files/${encodeURIComponent(fileId)}/versions`,
      body: form,
    });
  }
}

export class FilesApi {
  readonly versions: FileVersionsApi;

  constructor(private readonly http: HttpClient) {
    this.versions = new FileVersionsApi(http);
  }

  /**
   * List files matching `params`. `await` the result for the first page,
   * or `for await` it to stream every file across pages (fetched lazily —
   * `limit` sets the page size, `next` the starting cursor; stop early to
   * stop fetching).
   */
  list(params?: FileListParams): Paginator<FileResource> {
    return cursorPaginate(
      (next) =>
        this.http.request<Paginated<FileResource>>({
          method: "GET",
          path: "/v1/files",
          query: { ...params, next } as Record<string, unknown>,
        }),
      params?.next,
    );
  }

  upload(body: FileUploadBody): Promise<FileResource> {
    const form = toFormData(body);
    return this.http.request<FileResource>({
      method: "POST",
      path: "/v1/files",
      body: form,
    });
  }

  createText(body: FileCreateTextParams): Promise<FileResource> {
    return this.http.request<FileResource>({
      method: "POST",
      path: "/v1/files",
      body,
    });
  }

  get(fileId: string): Promise<FileResource> {
    return this.http.request<FileResource>({
      method: "GET",
      path: `/v1/files/${encodeURIComponent(fileId)}`,
    });
  }

  update(fileId: string, body: FileUpdateParams): Promise<FileResource> {
    return this.http.request<FileResource>({
      method: "PATCH",
      path: `/v1/files/${encodeURIComponent(fileId)}`,
      body,
    });
  }

  delete(fileId: string): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/v1/files/${encodeURIComponent(fileId)}`,
      expect: "empty",
    });
  }

  download(fileId: string): Promise<Uint8Array> {
    return this.http.request<Uint8Array>({
      method: "GET",
      path: `/v1/files/${encodeURIComponent(fileId)}/content`,
      expect: "bytes",
    });
  }

  downloadStream(fileId: string): Promise<ReadableStream<Uint8Array>> {
    return this.http.request<ReadableStream<Uint8Array>>({
      method: "GET",
      path: `/v1/files/${encodeURIComponent(fileId)}/content`,
      expect: "stream",
    });
  }
}

function toFormData(body: FileUploadBody): FormData {
  const fd = new FormData();
  if ("file" in body && body.file instanceof Blob) {
    fd.append("file", body.file, body.name);
  } else {
    // Uint8Array branch — copy into a fresh ArrayBuffer so the Blob
    // constructor sees a concrete ArrayBuffer (not ArrayBufferLike,
    // which TS rejects under nodenext lib).
    const u8 = (body as { file: Uint8Array }).file;
    const ct =
      (body as { contentType?: string }).contentType ??
      "application/octet-stream";
    const ab = u8.buffer.slice(
      u8.byteOffset,
      u8.byteOffset + u8.byteLength,
    ) as ArrayBuffer;
    fd.append("file", new Blob([ab], { type: ct }), body.name);
  }
  if (body.name) fd.append("name", body.name);
  if (body.file_type) fd.append("file_type", body.file_type);
  return fd;
}
