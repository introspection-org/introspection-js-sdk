import type { CursorParams, IsoDate, Uuid } from "./common.js";

/** `runtime`: a Recipe bake. `service`: a caller's `POST /v1/images`. */
export type ImageKind = "runtime" | "service";

export type ImageStatus =
  "queued" | "building" | "ready" | "failed" | "cancelled" | "evicted";

export type ImageScanStatus =
  "pending" | "passed" | "findings" | "failed" | "skipped";

export type ImageSourceKind = "context" | "mirror" | "bake";

/**
 * An image in the plane's registry (`/v1/images`, Data Plane), which is what
 * an eval task's compose services run as. Once `ready`, a service names it as
 * `${image_ref}@${image_digest}`.
 */
export interface Image {
  id: Uuid;
  kind: ImageKind;
  name: string;
  /** What a create dedupes on: a repeat create of the same content returns this row. */
  content_id: string;
  source_kind: ImageSourceKind;
  source: Record<string, unknown>;
  build_platform: string;
  service?: string | null;
  repository_id?: Uuid | null;
  git_sha?: string | null;
  git_ref?: string | null;
  path?: string;
  runtime_id?: Uuid | null;
  task_id?: Uuid | null;
  trigger?: string | null;
  base_image_digest?: string | null;
  base_image_tag?: string | null;
  external_artifacts?: Record<string, string> | null;
  external_image_name?: string | null;
  status: ImageStatus;
  image_ref?: string | null;
  image_digest?: string | null;
  size_bytes?: number | null;
  warnings?: string[];
  error?: string | null;
  scan_status?: ImageScanStatus | null;
  scan_started_at?: IsoDate | null;
  scanned_at?: IsoDate | null;
  scan_db_built_at?: IsoDate | null;
  scan_summary?: Record<string, unknown> | null;
  scan_report_file_id?: Uuid | null;
  created_at: IsoDate;
  updated_at: IsoDate;
  started_at?: IsoDate | null;
  finished_at?: IsoDate | null;
  last_used_at?: IsoDate | null;
  evicted_at?: IsoDate | null;
  retired_at?: IsoDate | null;
}

/** `GET /v1/images` filters. */
export interface ImageListParams extends CursorParams {
  kind?: ImageKind;
  status?: ImageStatus;
  name?: string;
  runtime_id?: Uuid;
}

/**
 * Build from a Dockerfile inside a `.tar.gz` uploaded through the Files API.
 */
export interface ContextImageSource {
  kind: "context";
  file_id: Uuid;
  /** A path inside the archive; defaults to `Dockerfile`. */
  dockerfile?: string;
  /** `linux/amd64` or `linux/arm64`; defaults to the plane's sandbox platform. */
  platform?: string;
}

/**
 * Copy an upstream image, pinned by digest (`…@sha256:…`), into the plane's
 * registry.
 */
export interface MirrorImageSource {
  kind: "mirror";
  reference: string;
}

/** Where an image's bytes come from, tagged by `kind`. */
export type ImageSource = ContextImageSource | MirrorImageSource;

/**
 * Where a Recipe publish built an image from, and the compose service it
 * runs as.
 */
export interface ImageProvenance {
  /** The compose service name, a DNS label. */
  service: string;
  repository_id?: Uuid;
  git_sha?: string;
  path?: string;
}

/** `POST /v1/images` body. */
export interface ImageCreateParams {
  /** Lowercase path segments, e.g. `hello-mcp/mcp-server`. */
  name: string;
  source: ImageSource;
  provenance?: ImageProvenance;
  /**
   * Ask for (`true`) or opt out of (`false`) a vulnerability scan within
   * what the plane's policy allows; omit to take the policy.
   */
  scan?: boolean;
}
