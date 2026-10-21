import type { IsoDate, ListParams, Uuid } from "./common.js";

export type FileType = "upload" | "filesystem" | "other";

export interface File {
  id: Uuid;
  org_id: Uuid;
  project_id: Uuid;
  created_at: IsoDate;
  updated_at: IsoDate;
  name: string;
  file_type: FileType;
  storage_path: string;
  mime_type: string;
  metadata?: Record<string, unknown> | null;
  member_id?: Uuid | null;
  size_bytes: number;
  version: number;
  parent_id?: Uuid | null;
  storage_version_id?: string | null;
  task_id?: Uuid | null;
  /**
   * Grouping tags stamped on this file. Tags belong to the file rather than
   * to a version, so they carry forward when a new version is written.
   */
  tags?: string[];
}

export interface FileListParams extends ListParams {
  name?: string;
  file_type?: FileType;
  storage_path?: string;
  /** Accounting view: files stamped with this task. Access rules still apply. */
  task_id?: Uuid;
  /**
   * Privileged credentials only: audit a specific owner. Replaced
   * `identity_key`, which the route stopped accepting when file ownership
   * converged onto member ids — and which FastAPI would have dropped as an
   * unknown query param, serving the caller every file in the project.
   */
  member_id?: Uuid;
  /** Filter by one tag. ANDed with the ownership predicate, so it only narrows. */
  tag?: string;
  /**
   * Filter: files whose `metadata` holds each of these pairs, matched exactly
   * against the string value. Sent as one repeated `metadata=key:value` param
   * per entry; entries are ANDed, at most 16.
   *
   * ```ts
   * client.files.list({ metadata: { source: "crm", tenant: "acme" } });
   * ```
   *
   * Keys are `[A-Za-z0-9_-]` with no `.`; values may contain colons. Narrows
   * only, like `tag`. A server that predates this filter ignores it and
   * returns the unfiltered list.
   */
  metadata?: Record<string, string>;
}

export interface FileUpdateParams {
  name?: string;
  metadata?: Record<string, unknown>;
  /**
   * Replaces the tag list wholesale (unlike `metadata`, which is merged).
   * Omit to leave tags untouched; pass `[]` to clear them.
   *
   * A tag is an opaque, exact, case-sensitive string: `key:value` is a
   * convention, not a grammar. Each tag is 1–128 characters with no
   * whitespace or control characters; at most 64 tags. Duplicates collapse.
   *
   * A caller whose member tags intersect a file's tags can still read and
   * write it implicitly, but that implicit tag access is deprecated and being
   * retired: to share with a cohort, create a tag share instead
   * (`shares.create({ granted_tag })`). Shared writers may not replace the
   * tags themselves; that remains owner/privileged-only.
   */
  tags?: string[];
}

export interface FileCreateTextParams {
  name: string;
  content: string;
  mime_type?: string;
  /** Arbitrary JSON metadata stored on the file. */
  metadata?: Record<string, unknown>;
  /**
   * Grouping tags, same rules as {@link FileUpdateParams.tags}. Stamped only
   * when this request creates the file; a new version keeps the file's
   * existing tags (a different set is rejected) — change them with `update`.
   */
  tags?: string[];
}
