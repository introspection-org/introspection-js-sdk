import type {
  Browser,
  BrowserCreateParams,
  BrowserListParams,
  BrowserUpdateParams,
  Paginated,
} from "@introspection-sdk/types";
import { Paginator, cursorPaginate } from "../pagination.js";
import type { ResourceHttpClient } from "./types.js";

/**
 * Standalone browsers (`/v1/browsers`).
 *
 * `create` returns at once with `status: "pending"`; poll `get` until it is
 * `ready`, then drive `cdp_ws_url` with any CDP client, including
 * `@introspection-sdk/browser-agent`. `delete` releases the browser and, when
 * it was created with `persist_profile`, writes its state back to the profile.
 */
export class BrowsersClient {
  constructor(private readonly http: ResourceHttpClient) {}

  /** `await` for the first page, or `for await` to stream every browser. */
  list(params?: BrowserListParams): Paginator<Browser> {
    return cursorPaginate(
      (next) =>
        this.http.request<Paginated<Browser>>({
          method: "GET",
          path: "/v1/browsers",
          query: { ...params, next } as Record<string, unknown>,
        }),
      params?.next,
    );
  }

  create(body: BrowserCreateParams = {}): Promise<Browser> {
    return this.http.request<Browser>({
      method: "POST",
      path: "/v1/browsers",
      body,
    });
  }

  get(browserId: string): Promise<Browser> {
    return this.http.request<Browser>({
      method: "GET",
      path: `/v1/browsers/${encodeURIComponent(browserId)}`,
    });
  }

  update(browserId: string, body: BrowserUpdateParams): Promise<Browser> {
    return this.http.request<Browser>({
      method: "PATCH",
      path: `/v1/browsers/${encodeURIComponent(browserId)}`,
      body,
    });
  }

  delete(browserId: string): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/v1/browsers/${encodeURIComponent(browserId)}`,
      expect: "empty",
    });
  }
}

export { BrowsersClient as BrowsersApi };
