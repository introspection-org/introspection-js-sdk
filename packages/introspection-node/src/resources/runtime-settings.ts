import type {
  Credential,
  CredentialCreateParams,
  CredentialUpdateParams,
  RuntimeSettingListParams,
  Variable,
  VariableCreateParams,
  VariableUpdateParams,
} from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import {
  ProjectScopedCollection,
  ProjectScopedResource,
} from "./project-scoped.js";

/**
 * `/v1/credentials` (Control Plane): secrets a project's runtimes read,
 * scoped to the project, a runtime group, a runtime or one lane.
 *
 * The secret is write-only: no read returns it; `update({ secret })` rotates
 * it. Gated on `credentials:read` / `credentials:write` /
 * `credentials:delete`, which only an org credential carries.
 */
export class CredentialsApi extends ProjectScopedResource<
  Credential,
  CredentialCreateParams,
  CredentialUpdateParams,
  RuntimeSettingListParams
> {
  constructor(http: HttpClient) {
    super(http, "/v1/credentials");
  }
}

/**
 * `/v1/variables` (Control Plane): environment variables a project's
 * runtimes read, scoped like {@link CredentialsApi}. The API has no read-one
 * route. Gated on `variables:read` / `variables:write` / `variables:delete`,
 * which only an org credential carries.
 */
export class VariablesApi extends ProjectScopedCollection<
  Variable,
  VariableCreateParams,
  VariableUpdateParams,
  RuntimeSettingListParams
> {
  constructor(http: HttpClient) {
    super(http, "/v1/variables");
  }
}
