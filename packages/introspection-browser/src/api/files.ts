/**
 * Cookie-authenticated Files client for the browser (`/v1/files`).
 *
 * Mirrors the Node SDK's runner-bound `FilesApi`, but rides the DP
 * `intro_dp_session` cookie via {@link BrowserHttpClient} instead of a
 * bearer token — so a single-page app reads and writes files with the
 * same identity session it uses for tasks and conversations. The DP
 * derives the owning `identity_key` from the session JWT; per-identity
 * file visibility is enforced server-side.
 */

import type {
  File as FileResource,
  FileCreateOptions,
  FileCreateTextParams,
  FileListParams,
  FileType,
  FileUpdateParams,
  ListParams,
  Paginated,
} from "@introspection-sdk/types";
import { Paginator, cursorPaginate } from "@introspection-sdk/http";
import { BrowserHttpClient } from "./http.js";

export type FileUploadBody =
  | { file: Blob; name?: string; file_type?: FileType }
  | {
      file: Uint8Array;
      name: string;
      file_type?: FileType;
      contentType?: string;
    };

/** Versions of a file (`/v1/files/{id}/versions`). */
export class FileVersionsClient {
  constructor(private readonly http: BrowserHttpClient) {}

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

  create(
    fileId: string,
    body: FileUploadBody,
    options?: FileCreateOptions,
  ): Promise<FileResource> {
    const form = toFormData(body, options);
    return this.http.request<FileResource>({
      method: "POST",
      path: `/v1/files/${encodeURIComponent(fileId)}/versions`,
      body: form,
    });
  }
}

/**
 * Cookie-authenticated `/v1/files` client. Mirrors the Node SDK's
 * `FilesApi` shape but is bound to a DP session cookie rather than a
 * bearer token.
 */
export class FilesClient {
  readonly versions: FileVersionsClient;

  constructor(private readonly http: BrowserHttpClient) {
    this.versions = new FileVersionsClient(http);
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

  upload(
    body: FileUploadBody,
    options?: FileCreateOptions,
  ): Promise<FileResource> {
    const form = toFormData(body, options);
    return this.http.request<FileResource>({
      method: "POST",
      path: "/v1/files",
      body: form,
    });
  }

  createText(
    body: FileCreateTextParams,
    options?: FileCreateOptions,
  ): Promise<FileResource> {
    return this.http.request<FileResource>({
      method: "POST",
      path: "/v1/files",
      body: options?.visibility
        ? { ...body, visibility: options.visibility }
        : body,
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

function toFormData(
  body: FileUploadBody,
  options?: FileCreateOptions,
): FormData {
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
  if (options?.visibility) fd.append("visibility", options.visibility);
  return fd;
}
