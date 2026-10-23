import type {
  Endpoint,
  EndpointCreateParams,
  EndpointListParams,
  EndpointUpdateParams,
} from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import { ProjectScopedResource } from "./project-scoped.js";

/**
 * `/v1/endpoints` (Control Plane): the hosts a project's runtimes may reach
 * through the egress, with the headers the egress adds. A connector's
 * authorization creates the MCP endpoint it binds. Gated on
 * `endpoints:read` / `endpoints:write` / `endpoints:delete`.
 */
export class EndpointsApi extends ProjectScopedResource<
  Endpoint,
  EndpointCreateParams,
  EndpointUpdateParams,
  EndpointListParams
> {
  constructor(http: HttpClient) {
    super(http, "/v1/endpoints");
  }
}
