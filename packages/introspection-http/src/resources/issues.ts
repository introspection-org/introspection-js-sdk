import type {
  Issue,
  IssueCreateParams,
  IssueListParams,
  IssuePatch,
  IssueWriteOptions,
  Uuid,
} from "@introspection-sdk/types";
import { Paginator, paginateGet } from "../pagination.js";
import { encodeMetadataFilter } from "./metadata-filter.js";
import { setFields } from "./set-fields.js";
import type { ResourceHttpClient } from "./types.js";

/** The `Idempotency-Key` header for a write, when the caller set one. */
function writeHeaders(
  options: IssueWriteOptions,
): { headers: Record<string, string> } | Record<string, never> {
  return options.idempotencyKey === undefined
    ? {}
    : { headers: { "Idempotency-Key": options.idempotencyKey } };
}

/** The PATCH body, with only the fields that are set. */
function patchBody(patch: IssuePatch): object {
  return "request" in patch && patch.request !== undefined
    ? { request: setFields(patch.request) }
    : setFields(patch);
}

/**
 * CRUD on `/v1/issues` (Data Plane). Reading needs `issues:read`, creating
 * and updating `issues:write`, and deleting `issues:delete`. Each write
 * takes an optional `idempotencyKey`, so a retried write applies once.
 */
export class IssuesClient {
  constructor(private readonly http: ResourceHttpClient) {}

  /**
   * List the issues the caller may read, newest activity first. `await` the
   * result for the first page, or `for await` it to stream every issue
   * across pages (fetched lazily; stop early to stop fetching). Filters ride
   * every page.
   */
  list(params: IssueListParams = {}): Paginator<Issue> {
    const { next: start, ...filters } = params;
    return paginateGet<Issue>(
      this.http,
      "/v1/issues",
      encodeMetadataFilter(filters),
      start,
    );
  }

  /** Open an issue on its worker task (`201`); see {@link IssueCreateParams}. */
  create(
    params: IssueCreateParams,
    options: IssueWriteOptions = {},
  ): Promise<Issue> {
    return this.http.request<Issue>({
      method: "POST",
      path: "/v1/issues",
      body: setFields(params),
      ...writeHeaders(options),
    });
  }

  /** Read one issue with its evidence, open requests and current `revision`. */
  get(issueId: Uuid): Promise<Issue> {
    return this.http.request<Issue>({
      method: "GET",
      path: `/v1/issues/${encodeURIComponent(issueId)}`,
    });
  }

  /**
   * Edit the brief ({@link IssueUpdateParams}, at the `expected_revision` it
   * was read at) or create or change one human request
   * ({@link IssueMutation}). Only the fields set are sent; a list sent as
   * `[]` clears it. Returns the updated issue.
   */
  update(
    issueId: Uuid,
    patch: IssuePatch,
    options: IssueWriteOptions = {},
  ): Promise<Issue> {
    return this.http.request<Issue>({
      method: "PATCH",
      path: `/v1/issues/${encodeURIComponent(issueId)}`,
      body: patchBody(patch),
      ...writeHeaders(options),
    });
  }

  /** Soft-delete an issue (`204`). Its activity history is kept. */
  delete(issueId: Uuid, options: IssueWriteOptions = {}): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/v1/issues/${encodeURIComponent(issueId)}`,
      expect: "empty",
      ...writeHeaders(options),
    });
  }
}

export { IssuesClient as IssuesApi };
