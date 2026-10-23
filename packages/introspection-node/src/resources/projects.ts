import type {
  Project,
  ProjectCreateParams,
  ProjectListParams,
  ProjectRef,
  ProjectUpdateParams,
} from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import { Paginator, paginateGet } from "../pagination.js";

/**
 * `/v1/projects` (Control Plane): the credential's org's projects,
 * addressed by slug or id. Reads are gated on `projects:read`; creating,
 * changing and deleting a project needs `projects:write` / `projects:delete`,
 * which only a member's own session carries, never an API key, an
 * Application or a CLI sign-in.
 */
export class ProjectsApi {
  constructor(private readonly http: HttpClient) {}

  /** Read one project by slug or id. One outside the org answers 404. */
  get(project: ProjectRef): Promise<Project> {
    return this.http.request<Project>({
      method: "GET",
      path: `/v1/projects/${encodeURIComponent(project)}`,
    });
  }

  /** `await` for the first page, or `for await` to stream every project. */
  list(params: ProjectListParams = {}): Paginator<Project> {
    return paginateGet<Project>(this.http, "/v1/projects", params, params.next);
  }

  /** Idempotent on `slug`: a repeat answers the live project. */
  create(params: ProjectCreateParams): Promise<Project> {
    return this.http.request<Project>({
      method: "POST",
      path: "/v1/projects",
      body: params,
    });
  }

  update(project: ProjectRef, params: ProjectUpdateParams): Promise<Project> {
    return this.http.request<Project>({
      method: "PATCH",
      path: `/v1/projects/${encodeURIComponent(project)}`,
      body: params,
    });
  }

  /** Soft-deletes the project and everything it owns on its Data Plane. */
  delete(project: ProjectRef): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/v1/projects/${encodeURIComponent(project)}`,
      expect: "empty",
    });
  }
}
