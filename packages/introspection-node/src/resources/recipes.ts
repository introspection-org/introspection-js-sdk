// jscpd:ignore-start -- import list: the same names as every resource client's
import type {
  ProjectRef,
  Recipe,
  RecipeCreateParams,
  RecipeListParams,
  RecipeUpdateParams,
  Uuid,
} from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import { Paginator, paginateGet } from "../pagination.js";
import { projectQuery } from "./project-scoped.js";
// jscpd:ignore-end

/**
 * `/v1/recipes` on the CP.
 *
 * A runner resolves the recipe it is running under; a credential holding
 * `recipes:write` (an org member, or an Application granted it) pins and
 * describes one, and `recipes:delete` (a member) removes it.
 *
 * Recipes are immutable build artefacts (repository + git ref + commit
 * sha + optional sub-path). They are referenced by runtimes via
 * `runtime.recipe_id` and by experiment arms via `arm.recipe_id`.
 */
export class RecipesApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * List recipes matching `params`. `await` the result for the first
   * page, or `for await` it to stream every recipe across pages (fetched
   * lazily — `limit` sets the page size, `next` the starting cursor; stop
   * early to stop fetching).
   */
  list(params: RecipeListParams = {}): Paginator<Recipe> {
    return paginateGet<Recipe>(this.http, "/v1/recipes", params, params.next);
  }

  get(id: Uuid): Promise<Recipe> {
    return this.http.request<Recipe>({
      method: "GET",
      path: `/v1/recipes/${encodeURIComponent(id)}`,
    });
  }

  /** Pin a repository at a ref or commit; a repeat of the same pin answers the live row. */
  create(params: RecipeCreateParams): Promise<Recipe> {
    return this.http.request<Recipe>({
      method: "POST",
      path: "/v1/recipes",
      body: params,
    });
  }

  update(
    id: Uuid,
    params: RecipeUpdateParams,
    project?: ProjectRef,
  ): Promise<Recipe> {
    return this.http.request<Recipe>({
      method: "PATCH",
      path: `/v1/recipes/${encodeURIComponent(id)}`,
      query: projectQuery(project),
      body: params,
    });
  }

  delete(id: Uuid, project?: ProjectRef): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/v1/recipes/${encodeURIComponent(id)}`,
      query: projectQuery(project),
      expect: "empty",
    });
  }
}

export function attachRecipes(http: HttpClient): RecipesApi {
  return new RecipesApi(http);
}
