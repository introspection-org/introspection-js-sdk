import type { CursorParams, IsoDate, Uuid } from "./common.js";
import type { ProjectRef } from "./projects.js";

export type EndpointKind = "llm" | "api" | "mcp";

export interface EndpointMetadata {
  mcp_server_id?: string | null;
  connector_id?: Uuid | null;
  provider_app?: string | null;
  auth_audience?: string | null;
  extra_hosts?: string[];
}

/**
 * An endpoint (`/v1/endpoints`, Control Plane): a host a runtime's sandbox
 * may reach, with the headers the egress adds. Header values are returned
 * to an operator; `header_names` lists them for everyone else.
 */
/** Where an MCP endpoint's tool discovery stands. */
export type McpCheckStatus = "pending" | "ok" | "failed" | "skipped";

/**
 * The last `initialize` + `tools/list` run against a `kind: mcp` endpoint.
 * A worker owns the result; a client can only ask for a fresh check.
 */
export interface EndpointMcpCheck {
  /** Identifies one requested check; a result lands only on its own check. */
  check_id: Uuid;
  status: McpCheckStatus;
  requested_at: IsoDate;
  /** The member whose connection authenticates a connector-backed binding during the check. */
  requested_by_member_id?: Uuid | null;
  checked_at?: IsoDate | null;
  /** `serverInfo.name` the server reported. Display only. */
  server_name?: string | null;
  /** Tool names the server listed; null until a check succeeds. */
  tools?: string[] | null;
  /** Why the check failed or was skipped. */
  error_message?: string | null;
}

export interface Endpoint {
  id: Uuid;
  org_id: Uuid;
  project_id: Uuid;
  name: string;
  host: string;
  base_url: string | null;
  kind: EndpointKind;
  metadata: EndpointMetadata;
  headers: Record<string, string>;
  header_names: string[];
  credential_refs: string[];
  assertion_claims: Record<string, string> | null;
  runtime_id: Uuid | null;
  runtime_group_id: Uuid | null;
  environment: string | null;
  verify_path: string | null;
  last_verified_at: IsoDate | null;
  authorized_application_id: Uuid | null;
  /** The last tool discovery run against a `kind: mcp` endpoint; null for other kinds. */
  mcp_check?: EndpointMcpCheck | null;
  created_by_member_id: Uuid;
  created_at: IsoDate;
  updated_at: IsoDate;
}

export interface EndpointListParams extends CursorParams {
  project?: ProjectRef;
  kind?: EndpointKind;
  runtime_id?: Uuid;
  /** A runtime group slug or id. */
  runtime?: string;
  environment?: string;
  mcp_server_id?: string;
}

/**
 * `POST /v1/endpoints`. A connector's authorization creates the MCP endpoint
 * it binds; this is the shape for the other kinds.
 */
export interface EndpointCreateParams {
  name: string;
  host: string;
  kind: EndpointKind;
  headers: Record<string, string>;
  base_url?: string | null;
  metadata?: EndpointMetadata;
  assertion_claims?: Record<string, string> | null;
  runtime_id?: Uuid | null;
  runtime_group_id?: Uuid | null;
  environment?: string | null;
  verify_path?: string | null;
  authorized_application_id?: Uuid | null;
}

/** `PATCH /v1/endpoints/{id}`; a change to the host or headers re-verifies. */
export type EndpointUpdateParams = Partial<EndpointCreateParams> & {
  /** Send `{}` to re-run tool discovery on a `kind: mcp` endpoint as the calling member. */
  mcp_check?: Record<string, never> | null;
};
