import type {
  Paginated,
  Recipe,
  RecipeCreate,
  RecipeListParams,
  RecipeUpdate,
  Uuid,
} from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";

/**
 * Programmatic CRUD for `/v1/recipes` on the CP.
 *
 * Recipes are immutable build artefacts (repository + git ref + commit
 * sha + optional sub-path). They are referenced by runtimes via
 * `runtime.recipe_id` and by experiment arms via `arm.recipe_id`.
 */
export class RecipesApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * Iterate recipes matching `params`. Pages are fetched lazily as the
   * iterator is consumed (`limit` sets the page size, `next` the
   * starting cursor); stop early to stop fetching.
   */
  async *list(params: RecipeListParams): AsyncIterable<Recipe> {
    let next: string | undefined = params.next;
    do {
      const page = await this.http.request<Paginated<Recipe>>({
        method: "GET",
        path: "/v1/recipes",
        query: { ...params, next } as unknown as Record<string, unknown>,
      });
      for (const r of page.records) yield r;
      next = page.next ?? undefined;
    } while (next);
  }

  get(id: Uuid): Promise<Recipe> {
    return this.http.request<Recipe>({
      method: "GET",
      path: `/v1/recipes/${encodeURIComponent(id)}`,
    });
  }

  create(input: RecipeCreate): Promise<Recipe> {
    return this.http.request<Recipe>({
      method: "POST",
      path: "/v1/recipes",
      body: input,
    });
  }

  update(id: Uuid, input: RecipeUpdate): Promise<Recipe> {
    return this.http.request<Recipe>({
      method: "PATCH",
      path: `/v1/recipes/${encodeURIComponent(id)}`,
      body: input,
    });
  }

  delete(id: Uuid): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/v1/recipes/${encodeURIComponent(id)}`,
      expect: "empty",
    });
  }
}

export function attachRecipes(http: HttpClient): RecipesApi {
  return new RecipesApi(http);
}
