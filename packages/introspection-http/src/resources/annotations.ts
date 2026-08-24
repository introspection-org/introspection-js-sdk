import type {
  Annotation,
  AnnotationCreateParams,
  AnnotationListParams,
  AnnotationUpdateParams,
  Paginated,
} from "@introspection-sdk/types";
import { Paginator, cursorPaginate } from "../pagination.js";
import type { ResourceHttpClient } from "./types.js";

/**
 * Runner-bound Annotations API (`/v1/annotations`).
 *
 * Expert-distillation open coding over conversations: `create` / `list` /
 * `get` / `update` / `delete`. An annotation is a `review`, a `mark`, or a
 * dataset `membership` row, optionally scoped to a selection within the
 * conversation. Reviews complete via `update(id, { completed: true })`.
 */
export class AnnotationsClient {
  constructor(private readonly http: ResourceHttpClient) {}

  /**
   * List annotations matching `params`. `await` for the first page, or
   * `for await` to stream every annotation across pages.
   */
  list(params?: AnnotationListParams): Paginator<Annotation> {
    return cursorPaginate(
      (next) =>
        this.http.request<Paginated<Annotation>>({
          method: "GET",
          path: "/v1/annotations",
          query: { ...params, next } as Record<string, unknown>,
        }),
      params?.next,
    );
  }

  /**
   * Create an annotation. Idempotent for pending-review and membership
   * dedup — a repeat create returns the existing row.
   */
  create(body: AnnotationCreateParams): Promise<Annotation> {
    return this.http.request<Annotation>({
      method: "POST",
      path: "/v1/annotations",
      body,
    });
  }

  /** Read a single annotation. */
  get(annotationId: string): Promise<Annotation> {
    return this.http.request<Annotation>({
      method: "GET",
      path: `/v1/annotations/${encodeURIComponent(annotationId)}`,
    });
  }

  /** Update an annotation (owner-only server-side). */
  update(
    annotationId: string,
    body: AnnotationUpdateParams,
  ): Promise<Annotation> {
    return this.http.request<Annotation>({
      method: "PATCH",
      path: `/v1/annotations/${encodeURIComponent(annotationId)}`,
      body,
    });
  }

  /** Delete an annotation. */
  delete(annotationId: string): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/v1/annotations/${encodeURIComponent(annotationId)}`,
      expect: "empty",
    });
  }
}

export { AnnotationsClient as AnnotationsApi };
