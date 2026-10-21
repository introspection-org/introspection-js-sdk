import type { CursorParams, Uuid } from "./common.js";

/**
 * The `?project=` selector most project-scoped Control Plane routes take: a
 * project slug or id, needed only when the credential does not already name
 * one (an org credential such as a member session).
 */
export type ProjectRef = string;

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
}

/** `GET /v1/projects` filters. The route lists the credential's org only. */
export interface ProjectListParams extends CursorParams {
  /** Only the project with this slug or id. */
  project?: ProjectRef;
}
