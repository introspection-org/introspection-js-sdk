import type {
  Project,
  ProjectListParams,
  ProjectRef,
} from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import { Paginator, paginateGet } from "../pagination.js";

/**
 * Reads on `/v1/projects` (Control Plane): the credential's org's projects,
 * addressed by slug or id. Gated on `projects:read`.
 *
 * Read-only: creating, changing and deleting a project needs
 * `projects:write` / `projects:delete`, which no API key, Application or CLI
 * sign-in carries.
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
}
