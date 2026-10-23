import type { CursorParams, ProjectRef, Uuid } from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import { Paginator, paginateGet } from "../pagination.js";

/** The `?project=` query for a selector, or none without one. */
export function projectQuery(
  project: ProjectRef | undefined,
): Record<string, unknown> | undefined {
  return project === undefined ? undefined : { project };
}

/**
 * List, create, update and delete on a project-scoped Control Plane
 * collection. Every route takes the optional `?project=` selector (a slug or
 * id), needed only when the credential names no project.
 */
export class ProjectScopedCollection<
  T,
  TCreate,
  TUpdate,
  TList extends CursorParams & { project?: ProjectRef },
> {
  constructor(
    protected readonly http: HttpClient,
    protected readonly path: string,
  ) {}

  /** `await` for the first page, or `for await` to stream every row. */
  list(params?: TList): Paginator<T> {
    return paginateGet<T>(this.http, this.path, params, params?.next);
  }

  create(params: TCreate, project?: ProjectRef): Promise<T> {
    return this.http.request<T>({
      method: "POST",
      path: this.path,
      query: projectQuery(project),
      body: params,
    });
  }

  update(id: Uuid, params: TUpdate, project?: ProjectRef): Promise<T> {
    return this.http.request<T>({
      method: "PATCH",
      path: this.itemPath(id),
      query: projectQuery(project),
      body: params,
    });
  }

  delete(id: Uuid, project?: ProjectRef): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: this.itemPath(id),
      query: projectQuery(project),
      expect: "empty",
    });
  }

  protected itemPath(id: Uuid): string {
    return `${this.path}/${encodeURIComponent(id)}`;
  }
}

/** {@link ProjectScopedCollection} with a read-one route. */
export class ProjectScopedResource<
  T,
  TCreate,
  TUpdate,
  TList extends CursorParams & { project?: ProjectRef },
> extends ProjectScopedCollection<T, TCreate, TUpdate, TList> {
  get(id: Uuid, project?: ProjectRef): Promise<T> {
    return this.http.request<T>({
      method: "GET",
      path: this.itemPath(id),
      query: projectQuery(project),
    });
  }
}
