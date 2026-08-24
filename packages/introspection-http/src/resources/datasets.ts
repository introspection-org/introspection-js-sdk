import type {
  Dataset,
  DatasetCreateParams,
  DatasetListParams,
  DatasetUpdateParams,
  Paginated,
} from "@introspection-sdk/types";
import { Paginator, cursorPaginate } from "../pagination.js";
import type { ResourceHttpClient } from "./types.js";

/**
 * Runner-bound Datasets API (`/v1/datasets`).
 *
 * Named conversation collections: `create` / `list` / `get` / `update` /
 * `delete`. Membership rides annotations — a `kind: "membership"` annotation
 * carrying `dataset_id` places its conversation in the dataset (see
 * `AnnotationsClient`).
 */
export class DatasetsClient {
  constructor(private readonly http: ResourceHttpClient) {}

  /**
   * List datasets matching `params`. `await` for the first page, or
   * `for await` to stream every dataset across pages.
   */
  list(params?: DatasetListParams): Paginator<Dataset> {
    return cursorPaginate(
      (next) =>
        this.http.request<Paginated<Dataset>>({
          method: "GET",
          path: "/v1/datasets",
          query: { ...params, next } as Record<string, unknown>,
        }),
      params?.next,
    );
  }

  /**
   * Create a dataset. Idempotent on the live slug — a repeat POST returns
   * the existing row. The server slugifies `slug`.
   */
  create(body: DatasetCreateParams): Promise<Dataset> {
    return this.http.request<Dataset>({
      method: "POST",
      path: "/v1/datasets",
      body,
    });
  }

  /** Read a single dataset. */
  get(datasetId: string): Promise<Dataset> {
    return this.http.request<Dataset>({
      method: "GET",
      path: `/v1/datasets/${encodeURIComponent(datasetId)}`,
    });
  }

  /** Update a dataset's description. */
  update(datasetId: string, body: DatasetUpdateParams): Promise<Dataset> {
    return this.http.request<Dataset>({
      method: "PATCH",
      path: `/v1/datasets/${encodeURIComponent(datasetId)}`,
      body,
    });
  }

  /** Soft-delete a dataset. */
  delete(datasetId: string): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/v1/datasets/${encodeURIComponent(datasetId)}`,
      expect: "empty",
    });
  }
}

export { DatasetsClient as DatasetsApi };
