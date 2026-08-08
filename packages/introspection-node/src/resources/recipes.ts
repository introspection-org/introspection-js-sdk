import type {
  Paginated,
  Recipe,
  RecipeListParams,
  Uuid,
} from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import { Paginator, cursorPaginate } from "../pagination.js";

/**
 * Read access to `/v1/recipes` on the CP.
 *
 * Lookup only: a runner resolves the recipe it is running under. Authoring
 * a recipe is a project-authoring act and lives in the CLI.
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
    return cursorPaginate(
      (next) =>
        this.http.request<Paginated<Recipe>>({
          method: "GET",
          path: "/v1/recipes",
          query: { ...params, next } as unknown as Record<string, unknown>,
        }),
      params.next,
    );
  }

  get(id: Uuid): Promise<Recipe> {
    return this.http.request<Recipe>({
      method: "GET",
      path: `/v1/recipes/${encodeURIComponent(id)}`,
    });
  }
}

export function attachRecipes(http: HttpClient): RecipesApi {
  return new RecipesApi(http);
}
