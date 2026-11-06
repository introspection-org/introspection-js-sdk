import type { CursorParams, Paginated } from "@introspection-sdk/types";
import { Paginator, paginateGet } from "../pagination.js";
import type { SchemaKey } from "../strict/schema-key.js";
import type { ResourceHttpClient } from "./types.js";

/**
 * List, read, create and delete on a `/v1/{plural}` collection whose rows
 * are addressed by id. A resource with more routes extends it. The schema
 * keys name the row and page types for strict decoding ({@link SchemaKey}).
 */
export class CollectionClient<T, TCreate, TList extends CursorParams> {
  constructor(
    protected readonly http: ResourceHttpClient,
    protected readonly basePath: string,
    protected readonly itemSchema?: SchemaKey<T>,
    protected readonly pageSchema?: SchemaKey<Paginated<T>>,
  ) {}

  protected itemPath(id: string): string {
    return `${this.basePath}/${encodeURIComponent(id)}`;
  }

  /** `await` for the first page, or `for await` to stream every row. */
  list(params?: TList): Paginator<T> {
    return paginateGet<T>(
      this.http,
      this.basePath,
      params,
      params?.next,
      this.pageSchema,
    );
  }

  get(id: string): Promise<T> {
    return this.http.request<T>({
      method: "GET",
      path: this.itemPath(id),
      schema: this.itemSchema,
    });
  }

  create(body: TCreate): Promise<T> {
    return this.http.request<T>({
      method: "POST",
      path: this.basePath,
      body,
      schema: this.itemSchema,
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
