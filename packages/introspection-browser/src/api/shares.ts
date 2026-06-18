/**
 * Cookie-authenticated Resource Shares client for the browser (`/v1/shares`).
 *
 * Read-sharing grants for files and conversations: `create` / `list` / `get` /
 * `delete` (revoke). A grant carries a `url` (with the `?share_id` capability) —
 * read the shared resource via `client.files.get(id, { shareId })` or
 * `client.conversations.items(id, { shareId })`. To fork a new task from a
 * shared conversation, pass `fork_share_id` to `client.tasks.create(...)`.
 */

import type {
  Paginated,
  ResourceShare,
  ShareCreateParams,
  ShareListParams,
} from "@introspection-sdk/types";
import { Paginator, cursorPaginate } from "@introspection-sdk/http";
import { BrowserHttpClient } from "./http.js";

/** Cookie-authenticated `/v1/shares` client. */
export class SharesClient {
  constructor(private readonly http: BrowserHttpClient) {}

  /**
   * List grants the caller created or that target them. `await` for the first
   * page, or `for await` to stream every grant across pages.
   */
  list(params?: ShareListParams): Paginator<ResourceShare> {
    return cursorPaginate(
      (next) =>
        this.http.request<Paginated<ResourceShare>>({
          method: "GET",
          path: "/v1/shares",
          query: { ...params, next } as Record<string, unknown>,
        }),
      params?.next,
    );
  }

  /** Create a read-sharing grant. The caller must own the target resource. */
  create(body: ShareCreateParams): Promise<ResourceShare> {
    return this.http.request<ResourceShare>({
      method: "POST",
      path: "/v1/shares",
      body,
    });
  }

  /** Read a single grant (carries the `url` to the shared resource). */
  get(shareId: string): Promise<ResourceShare> {
    return this.http.request<ResourceShare>({
      method: "GET",
      path: `/v1/shares/${encodeURIComponent(shareId)}`,
    });
  }

  /** Revoke a grant. Only the grantor (or an admin/owner) may revoke. */
  delete(shareId: string): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/v1/shares/${encodeURIComponent(shareId)}`,
      expect: "empty",
    });
  }
}
