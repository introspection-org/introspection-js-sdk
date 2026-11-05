import type {
  Issue,
  IssueCreateParams,
  IssueListParams,
  IssueMutation,
  IssuePatch,
  IssuePreconditionOptions,
  IssueUpdateParams,
  Uuid,
} from "@introspection-sdk/types";
import { Paginator, paginateGet } from "../pagination.js";
import { encodeMetadataFilter } from "./metadata-filter.js";
import { setFields } from "./set-fields.js";
import type { ResourceHttpClient } from "./types.js";

/** The `If-Match` header, when the caller set one. */
function preconditionHeaders(
  options: IssuePreconditionOptions,
): { headers: Record<string, string> } | Record<string, never> {
  return options.ifMatch === undefined
    ? {}
    : { headers: { "If-Match": options.ifMatch } };
}

function isMutation(patch: IssuePatch): patch is IssueMutation {
  return "request" in patch && patch.request !== undefined;
}

/**
 * CRUD on `/v1/issues` (Data Plane). Reading needs `issues:read`, creating
 * and updating `issues:write`, and deleting `issues:delete`. A brief edit
 * and a delete take an optional `ifMatch` (see `issueEtag`), so a write
 * against a stale read is refused with 412.
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
  create(params: IssueCreateParams): Promise<Issue> {
    return this.http.request<Issue>({
      method: "POST",
      path: "/v1/issues",
      body: setFields(params),
    });
  }

  /**
   * Read one issue with its evidence and open requests. Its `ETag` is
   * `issueEtag(issue)`.
   */
  get(issueId: Uuid): Promise<Issue> {
    return this.http.request<Issue>({
      method: "GET",
      path: `/v1/issues/${encodeURIComponent(issueId)}`,
    });
  }

  /**
   * Edit the brief ({@link IssueUpdateParams}) or create or change one human
   * request ({@link IssueMutation}). Only the fields set are sent; a list
   * sent as `[]` clears it. `ifMatch` applies to a brief edit only; with a
   * request mutation it throws before anything is sent. Returns the updated
   * issue.
   */
  update(
    issueId: Uuid,
    patch: IssueUpdateParams,
    options?: IssuePreconditionOptions,
  ): Promise<Issue>;
  update(issueId: Uuid, patch: IssuePatch): Promise<Issue>;
  update(
    issueId: Uuid,
    patch: IssuePatch,
    options: IssuePreconditionOptions = {},
  ): Promise<Issue> {
    if (!isMutation(patch)) {
      return this.http.request<Issue>({
        method: "PATCH",
        path: `/v1/issues/${encodeURIComponent(issueId)}`,
        body: setFields(patch),
        ...preconditionHeaders(options),
      });
    }
    if (options.ifMatch !== undefined) {
      return Promise.reject(
        new TypeError(
          "ifMatch applies to a brief edit only; a request mutation carries its own expected_revision",
        ),
      );
    }
    return this.http.request<Issue>({
      method: "PATCH",
      path: `/v1/issues/${encodeURIComponent(issueId)}`,
      body: { request: setFields(patch.request) },
    });
  }

  /** Soft-delete an issue (`204`). Its activity history is kept. */
  delete(issueId: Uuid, options: IssuePreconditionOptions = {}): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/v1/issues/${encodeURIComponent(issueId)}`,
      expect: "empty",
      ...preconditionHeaders(options),
    });
  }
}

export { IssuesClient as IssuesApi };
