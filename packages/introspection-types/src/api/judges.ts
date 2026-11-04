import type { CursorParams, IsoDate, Uuid } from "./common.js";
import type { ProjectRef } from "./projects.js";

/**
 * A judge a Recipe declares (`/v1/judges`, Control Plane). Its definition is
 * authored in the Recipe; only `enabled` and `sample_rate` are operational
 * and changeable here.
 */
export interface Judge {
  id: Uuid;
  org_id: Uuid;
  project_id: Uuid;
  runtime_group_id: Uuid;
  created_at: IsoDate;
  updated_at: IsoDate;
  name: string;
  description?: string | null;
  enabled: boolean;
  sample_rate: number;
  source: string;
  repository_id?: Uuid | null;
  recipe_git_commit_sha?: string | null;
  source_path?: string | null;
  definition_hash: string;
  created_by_member_id?: Uuid | null;
}

/** `GET /v1/judges` filters. */
export interface JudgeListParams extends CursorParams {
  project?: ProjectRef;
  runtime_group_id?: Uuid;
}

/** `PATCH /v1/judges/{id}` body. */
export interface JudgeUpdateParams {
  enabled?: boolean;
  /** The fraction of conversations judged, `0`–`1`. */
  sample_rate?: number;
}
