/**
 * Response shapes of the documented routes the SDK is exempt from today, as
 * the walk reads them. Only the fields the walk asserts on are typed; the
 * inline snapshots pin the rest.
 */

export interface Project {
  id: string;
  org_id: string;
  deployment_id: string;
  name: string;
  slug: string | null;
  description: string | null;
}

export interface Application {
  id: string;
  client_id: string;
  name: string;
  application_type: string;
  allowed_scopes: string[];
}

export interface ApplicationSecret {
  id: string;
  application_id: string;
  name: string | null;
  /** The plaintext, returned once on create. */
  secret?: string | null;
}

export interface Integration {
  id: string;
  type: string;
  status: string;
}

export interface Credential {
  id: string;
  name: string;
  secret?: string | null;
}

export interface Variable {
  id: string;
  name: string;
  kind: string;
  value: string | null;
}

export interface Endpoint {
  id: string;
  name: string;
  host: string;
  kind: string;
  metadata: { mcp_server_id?: string | null; connector_id?: string | null };
}

export interface Judge {
  id: string;
  name: string;
  enabled: boolean;
}

export interface ApiKey {
  id: string;
  name: string | null;
  environment: string;
  api_key?: string | null;
}

export interface TaskCommand {
  id: string;
  status: string;
  exit_code?: number | null;
  stdout?: string | null;
  output_file_id?: string | null;
}

export interface Paginated<T> {
  records: T[];
  next?: string | null;
}
