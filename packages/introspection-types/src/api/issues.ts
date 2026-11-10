import type { IsoDate, ListParams, Uuid } from "./common.js";
import type { TaskStatus } from "./tasks.js";

/** An issue's status. A new issue starts `open`. */
export type IssueStatus = "open" | "waiting" | "closed" | "cancelled";

/** An issue's priority. Server default `medium`. */
export type IssuePriority = "low" | "medium" | "high" | "urgent";

/**
 * Who owns an issue, for `GET /v1/issues?owner=`: `project` for a
 * project-owned (Operator) issue, `me` for the caller's own private ones.
 */
export type IssueOwner = "project" | "me";

/** A human request's status. `resolved` and `cancelled` need a `resolution`. */
export type IssueRequestStatus = "open" | "resolved" | "cancelled";

/** One value of an issue's caller-defined `metadata`. */
export type IssueMetadataValue = string | number | boolean | null;

/** A Data Plane file cited as evidence. */
export interface IssueFile {
  file_id: Uuid;
  name?: string | null;
  checksum?: string | null;
  source_event_ids?: Uuid[];
}

/** An HTTP or HTTPS link cited as evidence, such as a pull request. */
export interface IssueLink {
  /** At most 2048 characters. */
  url: string;
  /** At most 500 characters. */
  title?: string | null;
}

/** A recorded event cited as evidence; the caller must be able to read it. */
export interface IssueEventReference {
  event_id: Uuid;
}

/**
 * A conversation span cited as evidence; the caller must be able to read the
 * exact pair.
 */
export interface IssueSpanReference {
  /** 32 hex characters. */
  trace_id: string;
  /** 16 hex characters. */
  span_id: string;
}

/** One open human request, as projected onto its issue. */
export interface IssueOpenRequest {
  id: Uuid;
  question: string;
  /** The member the request is assigned to. */
  assignee_id: Uuid;
  created_at: IsoDate;
}

/**
 * One human request on an issue, as an `introspection.issue` event records it
 * on its `request.created` and `request.updated` actions.
 */
export interface IssueRequest {
  id: Uuid;
  issue_id: Uuid;
  /** The issue's worker task. */
  task_id: Uuid;
  question: string;
  /** The member the request is assigned to. */
  assignee_id: Uuid;
  status: IssueRequestStatus;
  /** The decision and its basis, once `resolved` or `cancelled`. */
  resolution?: string | null;
  /** Bumped on every change to the request. */
  revision: number;
  /** The parent issue's revision when the request was written. */
  issue_revision: number;
  /** The owning member of the parent issue; null for a project-owned (Operator) issue. */
  issue_member_id?: Uuid | null;
  files: IssueFile[];
  links: IssueLink[];
  events: IssueEventReference[];
  spans: IssueSpanReference[];
  created_at: IsoDate;
  updated_at: IsoDate;
}

/**
 * An issue (`/v1/issues`, Data Plane): a brief on a fixed worker task, the
 * evidence it cites and its open human requests.
 */
export interface Issue {
  id: Uuid;
  org_id: Uuid;
  project_id: Uuid;
  /** 1 to 500 characters. */
  title: string;
  description: string;
  priority: IssuePriority;
  status: IssueStatus;
  /** Bumped on every edit of the brief. */
  revision: number;
  /** Project-scoped display ID. */
  display_index?: number | null;
  /** The fixed worker task; nullable in the persisted schema. */
  task_id?: Uuid | null;
  /** The current status of the worker task. */
  task_status?: TaskStatus | null;
  /** The owning member of a private issue; null for a project-owned (Operator) issue. */
  member_id?: Uuid | null;
  /** Free-form tags, conventionally `key:value`. */
  tags: string[];
  /** Caller-defined attributes. */
  metadata: Record<string, IssueMetadataValue>;
  files: IssueFile[];
  links: IssueLink[];
  events: IssueEventReference[];
  spans: IssueSpanReference[];
  /** Open human requests, oldest first. */
  open_requests: IssueOpenRequest[];
  /** When the issue last entered `closed` or `cancelled`. */
  closed_at?: IsoDate | null;
  created_at: IsoDate;
  /** Also the issue's `ETag`; see {@link issueEtag}. */
  updated_at: IsoDate;
}

/**
 * The `ETag` the Data Plane returns for `issue`: its `updated_at` exactly as
 * the API renders it, quoted. It is never parsed into a `Date`, which would
 * drop the microseconds the server compares. Pass it as `ifMatch` to an
 * update or a delete so a write against a stale read is refused with 412.
 */
export function issueEtag(issue: Issue): string {
  return `"${issue.updated_at}"`;
}

/**
 * `POST /v1/issues`: open an issue on its fixed worker task. It starts
 * `open`; set its status later with an update.
 */
export interface IssueCreateParams {
  /** The worker task used by the issue chat and Slack replies. */
  task_id: Uuid;
  /** 1 to 500 characters. */
  title: string;
  /** 1 to 50000 characters. */
  description: string;
  /** Server default `medium`. */
  priority?: IssuePriority;
  tags?: string[];
  metadata?: Record<string, IssueMetadataValue>;
  files?: IssueFile[];
  links?: IssueLink[];
  events?: IssueEventReference[];
  spans?: IssueSpanReference[];
}

/**
 * Edit an issue's brief (`PATCH /v1/issues/{id}`). Only the fields set are
 * sent and an omitted one is unchanged. Each list, and `metadata`, replaces
 * the stored value wholesale: `[]` (or `{}`) clears it, so leave a field out
 * to keep it.
 */
export interface IssueUpdateParams {
  title?: string;
  description?: string;
  priority?: IssuePriority;
  status?: IssueStatus;
  tags?: string[];
  metadata?: Record<string, IssueMetadataValue>;
  files?: IssueFile[];
  links?: IssueLink[];
  events?: IssueEventReference[];
  spans?: IssueSpanReference[];
  /** Not part of a brief edit; see {@link IssueMutation}. */
  request?: never;
}

/**
 * Create one human request on an issue, or change one. An `id` the issue
 * does not have yet creates the request; an existing one changes it, and the
 * last write wins.
 */
export interface IssueRequestMutation {
  /** The request's id. Mint a new UUIDv7 to create one. */
  id: Uuid;
  /** What the assignee is asked; required to create. */
  question?: string;
  /** The member the request is assigned to; required to create, set again to reassign. */
  assignee_id?: Uuid;
  /** A new request is `open`. */
  status?: IssueRequestStatus;
  /** The decision and its basis; required for `resolved` and `cancelled`. */
  resolution?: string;
}

/**
 * `PATCH /v1/issues/{id}` with `{ request }`: create or change one human
 * request on the issue.
 */
export interface IssueMutation {
  request: IssueRequestMutation;
}

/** The body of `PATCH /v1/issues/{id}`: a brief edit or a request mutation. */
export type IssuePatch = IssueUpdateParams | IssueMutation;

/**
 * Query params for `GET /v1/issues` (`limit` 1 to 200, server default 50).
 * The list is newest activity first. A repeatable filter takes one value or
 * several, ORed.
 */
export interface IssueListParams extends ListParams {
  status?: IssueStatus | IssueStatus[];
  /** Omit for every issue the caller may read. */
  owner?: IssueOwner | IssueOwner[];
  /** `true`: has an open request assigned to the caller; `false`: has none. */
  assigned_to_me?: boolean;
  /** Whether any human request is open. */
  has_open_requests?: boolean;
  /** The worker task's status. */
  task_status?: TaskStatus | TaskStatus[];
  /** Leave out these worker task statuses; an issue without a live task is kept. */
  exclude_task_status?: TaskStatus | TaskStatus[];
  /** The project-scoped display ID. */
  display_index?: number;
  /** One `key:value` tag, such as `customer:acme`. */
  tag?: string;
  /**
   * Issues whose `metadata` holds each of these pairs. Sent as one repeated
   * `metadata=key:value` param per entry; entries are ANDed, at most 16.
   */
  metadata?: Record<string, string>;
}

/** Options for an issue brief edit or delete. A request mutation takes none. */
export interface IssuePreconditionOptions {
  /**
   * Sent as `If-Match`: the `ETag` the issue was read at, from
   * {@link issueEtag}. A stale one is refused with 412; omit it to write
   * without the check.
   */
  ifMatch?: string;
}
