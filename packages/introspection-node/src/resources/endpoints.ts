import type {
  Endpoint,
  EndpointListParams,
  EndpointUpdateParams,
  ProjectRef,
  Uuid,
} from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import { Paginator, paginateGet } from "../pagination.js";
import { projectQuery } from "./project-scoped.js";

/**
 * `/v1/endpoints` (Control Plane): the hosts a project's runtimes may reach
 * through the egress. A connector's authorization creates the MCP endpoint
 * it binds; the SDK reads, renames and removes endpoints and creates none.
 * Gated on `endpoints:read` / `endpoints:write` / `endpoints:delete`.
 */
export class EndpointsApi {
  constructor(private readonly http: HttpClient) {}

  /** `await` for the first page, or `for await` to stream every endpoint. */
  list(params: EndpointListParams = {}): Paginator<Endpoint> {
    return paginateGet<Endpoint>(
      this.http,
      "/v1/endpoints",
      params,
      params.next,
    );
  }

  get(endpointId: Uuid, project?: ProjectRef): Promise<Endpoint> {
    return this.http.request<Endpoint>({
      method: "GET",
      path: `/v1/endpoints/${encodeURIComponent(endpointId)}`,
      query: projectQuery(project),
    });
  }

  update(
    endpointId: Uuid,
    params: EndpointUpdateParams,
    project?: ProjectRef,
  ): Promise<Endpoint> {
    return this.http.request<Endpoint>({
      method: "PATCH",
      path: `/v1/endpoints/${encodeURIComponent(endpointId)}`,
      query: projectQuery(project),
      body: params,
    });
  }

  delete(endpointId: Uuid, project?: ProjectRef): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/v1/endpoints/${encodeURIComponent(endpointId)}`,
      query: projectQuery(project),
      expect: "empty",
    });
  }
}
