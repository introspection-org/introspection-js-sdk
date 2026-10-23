import type { CursorParams } from "@introspection-sdk/types";
import { Paginator, paginateGet } from "../pagination.js";
import type { ResourceHttpClient } from "./types.js";

/**
 * List, read, create and delete on a `/v1/{plural}` collection whose rows
 * are addressed by id. A resource with more routes extends it.
 */
export class CollectionClient<T, TCreate, TList extends CursorParams> {
  constructor(
    protected readonly http: ResourceHttpClient,
    protected readonly basePath: string,
  ) {}

  protected itemPath(id: string): string {
    return `${this.basePath}/${encodeURIComponent(id)}`;
  }

  /** `await` for the first page, or `for await` to stream every row. */
  list(params?: TList): Paginator<T> {
    return paginateGet<T>(this.http, this.basePath, params, params?.next);
  }

  get(id: string): Promise<T> {
    return this.http.request<T>({ method: "GET", path: this.itemPath(id) });
  }

  create(body: TCreate): Promise<T> {
    return this.http.request<T>({
      method: "POST",
      path: this.basePath,
      body,
    });
  }

  delete(id: string): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: this.itemPath(id),
      expect: "empty",
    });
  }
}
