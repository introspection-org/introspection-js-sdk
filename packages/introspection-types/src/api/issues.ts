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

/** How a member stands to an issue. */
export type IssueMemberRelation =
  "creator" | "assignee" | "reviewer" | "follower";

/**
 * A related list to return with an issue: `members` adds `members`,
 * `attachments` adds `links`, `files`, `events` and `spans`, and `comments`
 * adds `comments`. A list that is not included is null.
 */
export type IssueInclude = "members" | "attachments" | "comments";

/**
 * The includes the list and the writes take. `comments` is read with
 * `issues.get()` only.
 */
export type IssueStoredInclude = Exclude<IssueInclude, "comments">;

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

/** One person on an issue. */
export interface IssueMember {
  member_id: Uuid;
  relation: IssueMemberRelation;
}

/** One comment on an issue. Comments are append-only: never edited or deleted. */
export interface IssueComment {
  /** The comment's id, which is its event's id. */
  id: Uuid;
  issue_id: Uuid;
  comment: string;
  /** The authenticated member who commented. */
  member_id: Uuid | null;
  /** The member acting for `member_id`, when delegated. */
  actor_member_id: Uuid | null;
  /** The actor's capacity: `agent`, `dev` or `impersonation`. */
  actor_member_type: string | null;
  created_at: IsoDate;
}

/**
 * An issue (`/v1/issues`, Data Plane): a brief on a fixed worker task, the
 * people on it, and each related list the read asked for with `include`. A
 * list that was not included is null.
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
  /**
   * The display ID with the project's issue prefix, e.g. `I-7`; null without
   * a display index.
   */
  display_key?: string | null;
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
  /** The member who created the issue; null when its creator is not a member. */
  created_by_member_id: Uuid | null;
  /** The member the issue is assigned to; null when unassigned. */
  assignee_member_id: Uuid | null;
  /** The member reviewing the issue; null when it has none. */
  reviewer_member_id: Uuid | null;
  /**
   * With `include: ["members"]`: the creator, then the assignee, the
   * reviewer, and the followers in the order they were added.
   */
  members: IssueMember[] | null;
  /** With `include: ["attachments"]`. */
  files: IssueFile[] | null;
  /** With `include: ["attachments"]`. */
  links: IssueLink[] | null;
  /** With `include: ["attachments"]`. */
  events: IssueEventReference[] | null;
  /** With `include: ["attachments"]`. */
  spans: IssueSpanReference[] | null;
  /**
   * With `include: ["comments"]` on `issues.get()`: the comments, oldest
   * first, at most 500. Page the issue's events for more.
   */
  comments: IssueComment[] | null;
  /** When the issue last entered `closed` or `cancelled`. */
  closed_at?: IsoDate | null;
  /** What this read left out, such as the comments beyond the include's cap. */
  warnings?: string[];
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

// jscpd:ignore-start -- interface field lists mirroring the wire schema
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
  /** The member to assign the issue to. */
  assignee_member_id?: Uuid;
  /** The member to review the issue. */
  reviewer_member_id?: Uuid;
  /** The members following the issue, at most 50. */
  follower_member_ids?: Uuid[];
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
  /** Replaces the assignee; `null` unassigns the issue; omitted leaves it. */
  assignee_member_id?: Uuid | null;
  /** Replaces the reviewer; `null` clears it; omitted leaves it. */
  reviewer_member_id?: Uuid | null;
  /** Replaces the followers wholesale, at most 50; `[]` clears them. */
  follower_member_ids?: Uuid[];
}
// jscpd:ignore-end

/** `POST /v1/issues/{id}/comments`: comment on an issue. */
export interface IssueCommentCreateParams {
  /** 1 to 10000 characters. */
  comment: string;
}

/**
 * Query params for `GET /v1/issues` (`limit` 1 to 200, server default 50).
 * The list is newest activity first. A repeatable filter takes one value or
 * several, ORed.
 */
export interface IssueListParams extends ListParams {
  status?: IssueStatus | IssueStatus[];
  /** Omit for every issue the caller may read. */
  owner?: IssueOwner | IssueOwner[];
  /**
   * Issues the caller is on in one of these relations; with `member_id`,
   * that member's relations instead. `["assignee", "reviewer"]` is what is
   * waiting on the caller.
   */
  relation?: IssueMemberRelation | IssueMemberRelation[];
  /**
   * Whose relations to match instead of the caller's; alone, the issues that
   * member is on in any relation. Only an organization admin may name
   * another member.
   */
  member_id?: Uuid;
  /** The related lists to return on every row. */
  include?: IssueStoredInclude[];
  /** The worker task's status. */
  task_status?: TaskStatus | TaskStatus[];
  /** Leave out these worker task statuses; an issue without a live task is kept. */
  exclude_task_status?: TaskStatus | TaskStatus[];
  /** The project-scoped display ID. */
  display_index?: number;
  /** The display ID with the project's issue prefix, such as `I-7`. */
  display_key?: string;
  /** One `key:value` tag, such as `customer:acme`. */
  tag?: string;
  /**
   * Issues whose `metadata` holds each of these pairs. Sent as one repeated
   * `metadata=key:value` param per entry; entries are ANDed, at most 16.
   */
  metadata?: Record<string, string>;
}

/** Options for reading one issue. */
export interface IssueGetParams {
  /** The related lists to return with the brief. */
  include?: IssueInclude[];
}

/** Options for an issue create or update. */
export interface IssueWriteOptions {
  /** The related lists to return on the written issue. */
  include?: IssueStoredInclude[];
}

/** Options for an issue update or delete. */
export interface IssuePreconditionOptions {
  /**
   * Sent as `If-Match`: the `ETag` the issue was read at, from
   * {@link issueEtag}. A stale one is refused with 412; omit it to write
   * without the check.
   */
  ifMatch?: string;
}
