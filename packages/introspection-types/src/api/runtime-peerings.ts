import type { IsoDate, Uuid } from "./common.js";

/** A runtime group's slug or id. */
export type RuntimeGroupRef = string;

/**
 * A source project offering one of its runtime groups' configuration to
 * other projects (`/v1/projects/{project}/peerings`, Control Plane). The
 * `granted_*` fields name who it admits; a null one does not narrow.
 */
export interface RuntimePeering {
  id: Uuid;
  org_id: Uuid;
  /** The source project that offers the runtime group. */
  project_id: Uuid;
  runtime_group_id: Uuid;
  granted_org_id: Uuid | null;
  granted_project_id: Uuid | null;
  granted_deployment_id: Uuid | null;
  expires_at: IsoDate | null;
  created_by_member_id: Uuid | null;
  created_at: IsoDate;
  updated_at: IsoDate;
  deleted_at: IsoDate | null;
}
