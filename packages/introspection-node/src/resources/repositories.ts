import {
  ValidationError,
  type Repository,
  type RepositoryContent,
  type RepositoryContentGetParams,
  type RepositoryContentsParams,
  type RepositoryDirectory,
  type RepositoryEntry,
  type RepositoryGetParams,
  type RepositoryListParams,
  type Uuid,
} from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import { Paginator } from "../pagination.js";

/** Percent-encode each path segment, keeping `/` as the separator. */
function contentsPath(repositoryId: Uuid, path: string): string {
  const base = `/v1/repositories/${encodeURIComponent(repositoryId)}/contents`;
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.length
    ? `${base}/${segments.map(encodeURIComponent).join("/")}`
    : base;
}

/**
 * `client.repositories.contents` — callable to enumerate a directory,
 * with `.get` for one raw read (a directory page or a file).
 */
export interface RepositoryContentsApi {
  /**
   * Stream every entry of the directory at `params.path` (the root when
   * omitted), following the server's cursor across pages. `await` it for
   * the first page. Throws a {@link ValidationError} when the path is a file;
   * read files with {@link RepositoryContentsApi.get}.
   */
  (
    repositoryId: Uuid,
    params?: RepositoryContentsParams,
  ): Paginator<RepositoryEntry, RepositoryDirectory>;
  /** Read one path: a directory page or a file, discriminated on `type`. */
  get(
    repositoryId: Uuid,
    path: string,
    params?: RepositoryContentGetParams,
  ): Promise<RepositoryContent>;
}

/**
 * Repositories linked to a project. Lookup is on the CP; `contents` reads
 * files and directories through the DP.
 *
 * `GET /v1/repositories` answers a bare array rather than the cursor
 * envelope, so {@link RepositoriesApi.list} returns an array.
 */
export class RepositoriesApi {
  readonly contents: RepositoryContentsApi;

  constructor(
    private readonly cpHttp: HttpClient,
    private readonly dpHttp: HttpClient,
  ) {
    const get = (
      repositoryId: Uuid,
      path: string,
      params: RepositoryContentGetParams = {},
    ): Promise<RepositoryContent> =>
      this.dpHttp.request<RepositoryContent>({
        method: "GET",
        path: contentsPath(repositoryId, path),
        query: { ...params },
      });
    const enumerate = (
      repositoryId: Uuid,
      params: RepositoryContentsParams = {},
    ): Paginator<RepositoryEntry, RepositoryDirectory> => {
      const path = params.path ?? "";
      return new Paginator<RepositoryEntry, RepositoryDirectory>({
        fetch: async (cursor) => {
          const content = await get(repositoryId, path, {
            ref: params.ref,
            limit: params.limit,
            cursor,
          });
          if (content.type !== "dir") {
            throw new ValidationError({
              message: `'${content.path}' is a file, not a directory; read it with repositories.contents.get()`,
              status: 422,
              code: "repository_path_is_file",
              body: null,
            });
          }
          return content;
        },
        items: (page) => page.records,
        next: (page) => page.next || undefined,
      });
    };
    this.contents = Object.assign(enumerate, { get });
  }

  /** `GET /v1/repositories?project=…[&slug=…]` — every repository in one array. */
  list(params: RepositoryListParams): Promise<Repository[]> {
    return this.cpHttp.request<Repository[]>({
      method: "GET",
      path: "/v1/repositories",
      query: { ...params },
    });
  }

  get(repositoryId: Uuid, params: RepositoryGetParams): Promise<Repository> {
    return this.cpHttp.request<Repository>({
      method: "GET",
      path: `/v1/repositories/${encodeURIComponent(repositoryId)}`,
      query: { ...params },
    });
  }
}

export function attachRepositories(
  cpHttp: HttpClient,
  dpHttp: HttpClient,
): RepositoriesApi {
  return new RepositoriesApi(cpHttp, dpHttp);
}
