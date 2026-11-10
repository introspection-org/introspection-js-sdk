import type {
  Issue,
  IssueComment,
  IssueCommentCreateParams,
  IssueCreateParams,
  IssueGetParams,
  IssueListParams,
  IssuePreconditionOptions,
  IssueUpdateParams,
  IssueWriteOptions,
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

/** The `include` query, when the caller asked for a related list. */
function includeQuery(options: {
  include?: string[];
}): { query: Record<string, unknown> } | Record<string, never> {
  return options.include?.length ? { query: { include: options.include } } : {};
}

/**
 * Comments on an issue (`/v1/issues/{id}/comments`). A comment is an
 * `introspection.issue` event: read comments with
 * `issues.get(id, { include: ["comments"] })` or from the issue's events.
 */
export class IssueCommentsClient {
  constructor(private readonly http: ResourceHttpClient) {}

  /**
   * Comment on an issue (`201`); needs `issues:write`. The comment does not
   * edit the issue, so its `ETag` is unchanged, and a read made straight
   * after may not include it yet.
   */
  create(
    issueId: Uuid,
    params: IssueCommentCreateParams,
  ): Promise<IssueComment> {
    return this.http.request<IssueComment>({
      method: "POST",
      path: `/v1/issues/${encodeURIComponent(issueId)}/comments`,
      schema: "IssueComment",
      body: params,
    });
  }
}

/**
 * CRUD on `/v1/issues` (Data Plane). Reading needs `issues:read`, creating
 * and updating `issues:write`, and deleting `issues:delete`. An update and a
 * delete take an optional `ifMatch` (see `issueEtag`), so a write against a
 * stale read is refused with 412.
 */
export class IssuesClient {
  /** Comments on an issue: `issues.comments.create(...)`. */
  readonly comments: IssueCommentsClient;

  constructor(private readonly http: ResourceHttpClient) {
    this.comments = new IssueCommentsClient(http);
  }

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
      "Paginated<Issue>",
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
      schema: "Issue",
      body: setFields(params),
      ...includeQuery(options),
    });
  }

  /**
   * Read one issue, with the related lists `include` names. Its `ETag` is
   * `issueEtag(issue)`.
   */
  get(issueId: Uuid, params: IssueGetParams = {}): Promise<Issue> {
    return this.http.request<Issue>({
      method: "GET",
      path: `/v1/issues/${encodeURIComponent(issueId)}`,
      schema: "Issue",
      ...includeQuery(params),
    });
  }

  /**
   * Edit an issue ({@link IssueUpdateParams}). Only the fields set are sent;
   * a list sent as `[]` clears it, and `assignee_member_id: null` or
   * `reviewer_member_id: null` clears that person. Returns the updated issue.
   */
  update(
    issueId: Uuid,
    patch: IssueUpdateParams,
    options: IssuePreconditionOptions & IssueWriteOptions = {},
  ): Promise<Issue> {
    return this.http.request<Issue>({
      method: "PATCH",
      path: `/v1/issues/${encodeURIComponent(issueId)}`,
      schema: "Issue",
      body: setFields(patch),
      ...preconditionHeaders(options),
      ...includeQuery(options),
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

export { IssuesClient as IssuesApi, IssueCommentsClient as IssueCommentsApi };
