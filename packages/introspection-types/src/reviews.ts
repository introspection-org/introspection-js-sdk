import type { CursorParams, IsoDate, ListParams, Uuid } from "./api.js";

/** One trace/span target for qualitative review. IDs use OTel hex encoding. */
export interface ReviewTarget {
  trace_id: string;
  span_id: string;
}

/** Current qualitative-review state folded from append-only review events. */
export interface ReviewState extends ReviewTarget {
  conversation_id: string | null;
  labels: string[];
  assignee_member_ids: Uuid[];
  annotator_member_ids: Uuid[];
  has_comment: boolean;
  comment_count: number;
  latest_comment: string | null;
  latest_comment_member_id: Uuid | null;
  updated_at: IsoDate;
  updated_by_member_id: Uuid;
  assignment_event_id: Uuid | null;
}

/** Filters for the folded project review queue. */
export interface ReviewListParams extends ListParams {
  annotated_by_member_id?: Uuid;
  assignee_member_id?: Uuid;
  trace_id?: string;
  span_id?: string;
  conversation_id?: string;
  label?: string;
}

/**
 * Exactly one append-only review mutation. Label and assignee arrays are
 * complete snapshots; an empty array explicitly clears that dimension.
 */
export type ReviewMutation =
  | {
      labels: string[];
      comment?: never;
      assignee_member_ids?: never;
    }
  | {
      comment: string;
      labels?: never;
      assignee_member_ids?: never;
    }
  | {
      assignee_member_ids: Uuid[];
      labels?: never;
      comment?: never;
    };

/** Optional stable identity for replaying the same append-only event. */
export interface ReviewEventOptions {
  /** Must be UUIDv7. Omit to have the SDK mint one before the first attempt. */
  event_id?: Uuid;
}

/** Presentation metadata for a reusable project review label. */
export interface ProjectLabel {
  slug: string;
  color: string;
  description: string | null;
  created_at: IsoDate;
  updated_at: IsoDate;
}

export interface ProjectLabelListParams extends CursorParams {
  search?: string;
}

export interface ProjectLabelCreate {
  slug: string;
  color: string;
  description?: string | null;
}

/** Label slugs and colors are immutable after creation. */
export interface ProjectLabelUpdate {
  description: string | null;
}
