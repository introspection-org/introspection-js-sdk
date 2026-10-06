import type {
  Issue,
  IssueCreateParams,
  IssueListParams,
  IssueRequestParams,
  IssueUpdateParams,
  IssueWriteOptions,
  Paginated,
  Uuid,
} from "@introspection-sdk/types";
import { encodeMetadataFilter } from "@introspection-sdk/http";
import type { HttpClient } from "../http.js";
import { Paginator, cursorPaginate } from "../pagination.js";

/** The fields of `params` that are set, so a PATCH never sends an absent one. */
function setFields<T extends object>(params: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function idempotencyHeaders(
  options?: IssueWriteOptions,
): { headers: Record<string, string> } | Record<string, never> {
  return options?.idempotencyKey
    ? { headers: { "Idempotency-Key": options.idempotencyKey } }
    : {};
}

/**
 * CRUD on `/v1/issues` (Data Plane): the project's pursuits, each with a
 * living brief and a fixed worker task. Their history is the activity
 * stream, not this resource.
 *
 * Reads need `issues:read`, create and update `issues:write`, delete
 * `issues:delete`.
 */
export class IssuesApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * List issues, newest activity first. `await` the result for the first
   * page, or `for await` it to stream every issue across pages. Filters
   * ride every page.
   */
  list(params: IssueListParams = {}): Paginator<Issue> {
    const { next: start, ...filters } = params;
    const query = encodeMetadataFilter(filters);
    return cursorPaginate(
      (next) =>
        this.http.request<Paginated<Issue>>({
          method: "GET",
          path: "/v1/issues",
          query: { ...query, next } as Record<string, unknown>,
        }),
      start,
    );
  }

  /** Create an issue bound to its worker task. */
  create(
    params: IssueCreateParams,
    options?: IssueWriteOptions,
  ): Promise<Issue> {
    return this.http.request<Issue>({
      method: "POST",
      path: "/v1/issues",
      body: setFields(params),
      ...idempotencyHeaders(options),
    });
  }

  /** Read one issue. */
  get(issueId: Uuid): Promise<Issue> {
    return this.http.request<Issue>({
      method: "GET",
      path: `/v1/issues/${encodeURIComponent(issueId)}`,
    });
  }

  /**
   * Edit the brief at `expected_revision` (only the fields set are sent), or
   * create or change one human request with `{ request }`.
   */
  update(
    issueId: Uuid,
    params: IssueUpdateParams | IssueRequestParams,
    options?: IssueWriteOptions,
  ): Promise<Issue> {
    return this.http.request<Issue>({
      method: "PATCH",
      path: `/v1/issues/${encodeURIComponent(issueId)}`,
      body: setFields(params),
      ...idempotencyHeaders(options),
    });
  }

  /** Soft-delete an issue. */
  delete(issueId: Uuid, options?: IssueWriteOptions): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/v1/issues/${encodeURIComponent(issueId)}`,
      expect: "empty",
      ...idempotencyHeaders(options),
    });
  }
}
