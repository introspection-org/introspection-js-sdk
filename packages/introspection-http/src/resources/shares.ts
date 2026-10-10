import type {
  Paginated,
  ResourceShare,
  ShareCreateParams,
  ShareListParams,
  ShareUpdateParams,
} from "@introspection-sdk/types";
import { Paginator, cursorPaginate } from "../pagination.js";
import type { ResourceHttpClient } from "./types.js";

/**
 * Runner-bound Resource Shares API (`/v1/shares`).
 *
 * Sharing grants for files, conversations and issues: `create` / `list` /
 * `get` / `update` / `delete` (revoke). A grant targets a member, a tag
 * (`granted_tag`), both, or the whole project, and applies ambiently: the
 * grantee reads the resource through its ordinary list and get routes. To
 * fork a new task from a shared conversation, pass `fork_share_id` to
 * `runner.tasks.create(...)`.
 */
export class SharesClient {
  constructor(private readonly http: ResourceHttpClient) {}

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

  /**
   * Create a grant. The caller must own the target resource, and for a tag
   * share also hold the tag (or be an admin).
   */
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

  /**
   * Change a conversation grant's `visible_from` (`null` clears it); the
   * grantee cannot change. Only the grantor (or an admin) may update.
   */
  update(shareId: string, body: ShareUpdateParams): Promise<ResourceShare> {
    return this.http.request<ResourceShare>({
      method: "PATCH",
      path: `/v1/shares/${encodeURIComponent(shareId)}`,
      body,
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

export { SharesClient as SharesApi };
