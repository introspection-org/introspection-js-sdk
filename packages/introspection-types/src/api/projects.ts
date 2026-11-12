import type { CursorParams, Uuid } from "./common.js";

/**
 * The `?project=` selector most project-scoped Control Plane routes take: a
 * project slug or id, needed only when the credential does not already name
 * one (an org credential such as a member session).
 */
export type ProjectRef = string;

/**
 * The letters a project's display IDs start with, such as the `I` in `I-7`.
 */
export interface DisplayIdPrefixes {
  /** Server default `I`. */
  issue: string;
  /** Server default `R`. */
  report: string;
  /** Server default `F`. */
  observation: string;
  /** Server default `T`. */
  task: string;
}

/** A project (`/v1/projects`, Control Plane). */
export interface Project {
  id: Uuid;
  org_id: Uuid;
  /** The Data Plane deployment the project lives on. */
  deployment_id: Uuid;
  name: string;
  /**
   * The stable identifier the CLI and dashboard URLs use. A project created
   * before slugs existed may have none.
   */
  slug?: string | null;
  description: string | null;
  settings?: Record<string, unknown> | null;
  created_by_member_id?: Uuid | null;
  display_id_prefixes: DisplayIdPrefixes;
}

/** `GET /v1/projects` filters. The route lists the credential's org only. */
export interface ProjectListParams extends CursorParams {
  /** Only the project with this slug or id. */
  project?: ProjectRef;
}

/** `POST /v1/projects`. The slug derives from the name when omitted. */
export interface ProjectCreateParams {
  name: string;
  /** The Data Plane deployment the project lives on. */
  deployment_id: Uuid;
  slug?: string;
  description?: string | null;
  /** Each prefix left out takes its server default. */
  display_id_prefixes?: Partial<DisplayIdPrefixes>;
}

/** `PATCH /v1/projects/{project}`. */
export interface ProjectUpdateParams {
  name?: string;
  description?: string | null;
  /** The prefixes to change; one left out keeps its current value. */
  display_id_prefixes?: Partial<DisplayIdPrefixes>;
  settings?: Record<string, unknown> | null;
}
