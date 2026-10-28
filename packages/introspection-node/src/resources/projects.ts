import type {
  CursorParams,
  Project,
  ProjectCreateParams,
  ProjectListParams,
  ProjectRef,
  ProjectUpdateParams,
  RuntimeGroupRef,
  RuntimePeering,
  Uuid,
} from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import { Paginator, paginateGet } from "../pagination.js";

function peeringsPath(project: ProjectRef): string {
  return `/v1/projects/${encodeURIComponent(project)}/peerings`;
}

/**
 * `/v1/projects/{project}/peerings`: the runtime groups a project offers to
 * other projects, and those other projects offer to it. Read-only, gated on
 * `projects:read`; creating or revoking a peering is a person's act in the
 * web app, and no API key carries `projects:write`.
 */
export class ProjectPeeringsApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * The peerings `project` offers, or only those on `runtime` (a runtime
   * group slug or id). `await` for the first page, or `for await` to stream.
   */
  list(
    project: ProjectRef,
    runtime?: RuntimeGroupRef,
    params: CursorParams = {},
  ): Paginator<RuntimePeering> {
    return paginateGet<RuntimePeering>(
      this.http,
      peeringsPath(project),
      { runtime, limit: params.limit },
      params.next,
    );
  }

  /** The peerings other projects grant to `project`. */
  granted(
    project: ProjectRef,
    params: CursorParams = {},
  ): Paginator<RuntimePeering> {
    return paginateGet<RuntimePeering>(
      this.http,
      peeringsPath(project),
      { granted: true, limit: params.limit },
      params.next,
    );
  }

  /** One peering `project` offers or is admitted by; any other answers 404. */
  get(project: ProjectRef, peeringId: Uuid): Promise<RuntimePeering> {
    return this.http.request<RuntimePeering>({
      method: "GET",
      path: `${peeringsPath(project)}/${encodeURIComponent(peeringId)}`,
    });
  }
}

/**
 * `/v1/projects` (Control Plane): the credential's org's projects,
 * addressed by slug or id. Reads are gated on `projects:read`; creating,
 * changing and deleting a project needs `projects:write` / `projects:delete`,
 * which only a member's own session carries, never an API key, an
 * Application or a CLI sign-in.
 */
export class ProjectsApi {
  /** Read-only runtime peerings, offered by or granted to a project. */
  readonly peerings: ProjectPeeringsApi;

  constructor(private readonly http: HttpClient) {
    this.peerings = new ProjectPeeringsApi(http);
  }

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
