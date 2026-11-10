import type { IsoDate, ListParams, Uuid } from "./api.js";

/** One trace/span target for a member-authored annotation. IDs use OTel hex encoding. */
export interface AnnotationTarget {
  trace_id: string;
  span_id: string;
}

/** Current annotation state folded from append-only annotation events. */
export interface AnnotationState extends AnnotationTarget {
  conversation_id: string | null;
  labels: string[];
  assignee_member_ids: Uuid[];
  /** Members whose comment completed a review. */
  reviewer_member_ids: Uuid[];
  comment_count: number;
  updated_at: IsoDate;
  updated_by_member_id: Uuid;
  assignment_event_id: Uuid | null;
}

/** One filter bucket over current annotation state (`GET /v1/annotations/facets`). */
export interface AnnotationFacet {
  /** `annotator`, `assignee`, `label`, `review_queue` or `status`. */
  dimension: string;
  value: string;
  count: number;
  /** Set on the `label` and `review_queue` buckets, which summarize a dataset. */
  conversation_count?: number | null;
  comment_count?: number | null;
  reviewer_member_ids?: Uuid[] | null;
  updated_at?: IsoDate | null;
}

/** `GET /v1/annotations/navigation` filters: the review order around one target. */
export interface AnnotationNavigationParams extends AnnotationTarget {
  annotated_by_member_id?: Uuid;
  assignee_member_id?: Uuid;
  /** Only targets carrying every one of these labels. */
  label?: string[];
  status?: "backlog" | "assigned" | "reviewed";
}

/** A bounded window around one annotation in the filtered review order. */
export interface AnnotationNavigation {
  previous: AnnotationState | null;
  current: AnnotationState | null;
  next: AnnotationState | null;
  current_position: number | null;
  total_count: number;
}

/** Filters for folded annotation state. */
export interface AnnotationListParams extends ListParams {
  annotated_by_member_id?: Uuid;
  assignee_member_id?: Uuid;
  /** Resolve this active Business-member email before reading. */
  annotated_by_email?: string;
  /** Resolve this active Business-member email before reading. */
  assigned_to_email?: string;
  trace_id?: string;
  span_id?: string;
  conversation_id?: string;
  /** Only targets carrying this label, or every one of these labels. */
  label?: string | string[];
  status?: "backlog" | "assigned" | "reviewed";
}

/**
 * `GET /v1/annotations/export` filters: the list's, without paging, since the
 * export streams every matching row.
 */
export type AnnotationExportParams = Omit<
  AnnotationListParams,
  keyof ListParams
>;

/**
 * Exactly one append-only annotation mutation. Label and reviewer arrays are
 * complete snapshots; an empty array explicitly clears that dimension.
 */
export type AnnotationMutation =
  | {
      labels: string[];
      comment?: never;
      reviewerEmails?: never;
    }
  | {
      comment: string;
      labels?: never;
      reviewerEmails?: never;
    }
  | {
      reviewerEmails: string[];
      labels?: never;
      comment?: never;
    };

/** Optional stable identity for replaying the same append-only event. */
export interface AnnotationEventOptions {
  /** Must be UUIDv7. Omit to have the SDK mint one before the first attempt. */
  event_id?: Uuid;
}
