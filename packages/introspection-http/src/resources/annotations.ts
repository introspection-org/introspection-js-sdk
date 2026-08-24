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
 * Expert-distillation open coding over spans: `create` / `list` / `get` /
 * `update` / `delete`. An annotation is a member's labels + comment on one
 * OpenTelemetry span (`trace_id` + `span_id`); a row without `completed_at`
 * is a pending review, finished via `update(id, { completed: true })`.
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
   * Create an annotation on a span. Completed by default; pass
   * `completed: false` to create a pending review instead.
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
