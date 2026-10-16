import type { CursorParams, IsoDate } from "./api.js";

/**
 * Which catalogue a tag belongs to. `access` tags are the values tag shares
 * and member tags carry; `annotation` tags are the annotation labels. The two
 * are separate catalogues with separate scopes, and no listing spans both.
 */
export type TagKind = "access" | "annotation";

/** A catalogue row: a tag people pick from. It grants nothing. */
export interface Tag {
  kind: TagKind;
  name: string;
  /** Set on an `annotation` tag; never on an `access` tag. */
  color: string | null;
  description: string | null;
  created_at: IsoDate;
  updated_at: IsoDate;
}

export interface TagListParams extends CursorParams {
  search?: string;
}

/** An access tag's name is opaque and kept verbatim, so it may contain `/`. */
export interface AccessTagCreate {
  kind: "access";
  name: string;
  description?: string | null;
  /** An access tag has no color. */
  color?: never;
}

export interface AnnotationTagCreate {
  kind: "annotation";
  /** Slugified by the API, so a display name is accepted here. */
  name: string;
  /** A six-digit hex color such as `#f97316`. */
  color: string;
  description?: string | null;
}

/**
 * A tag to add. The kind picks the shape, so an access tag has no color to
 * set and an annotation tag cannot omit one.
 */
export type TagCreate = AccessTagCreate | AnnotationTagCreate;

/**
 * A field left out is left as it is; `description: null` clears it. The API
 * distinguishes an omitted key from a null.
 */
export interface TagUpdate {
  /** Annotation tags only. */
  color?: string;
  description?: string | null;
}
