import type {
  Paginated,
  Recipe,
  RunRequest,
  Runtime,
  RuntimeCreate,
  RuntimeListParams,
  RuntimeUpdate,
  RunnerSpec,
  Uuid,
} from "@introspection-sdk/types";
import { NotFoundError } from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import type { IntrospectionClient } from "../client.js";
import { Paginator, cursorPaginate } from "../pagination.js";
import { Runner, type RunnerSource } from "../runner.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export interface RuntimeRunRequestBody {
  identity?: {
    user_id?: string;
    anonymous_id?: string;
    conversation_id?: string;
  };
  ttl_seconds?: number;
  recipe_id?: Uuid;
}

function toRunBody(opts?: RunRequest): RuntimeRunRequestBody | undefined {
  if (!opts) return undefined;
  const out: RuntimeRunRequestBody = {};
  if (opts.identity) out.identity = opts.identity;
  if (opts.ttl_seconds !== undefined) out.ttl_seconds = opts.ttl_seconds;
  if (opts.recipe_id !== undefined) out.recipe_id = opts.recipe_id;
  return out;
}

/**
 * Programmatic CRUD for `/v1/runtimes` on the CP. Mounted on the
 * IntrospectionClient as a callable hybrid (see `RuntimeHandleFactory`).
 */
export class RuntimesApi {
  constructor(
    private readonly http: HttpClient,
    private readonly client: IntrospectionClient,
  ) {}

  /**
   * List runtimes matching `params`. `await` the result for the first
   * page, or `for await` it to stream every runtime across pages (fetched
   * lazily — `limit` sets the page size, `next` the starting cursor; stop
   * early to stop fetching).
   */
  list(params: RuntimeListParams): Paginator<Runtime> {
    return cursorPaginate(
      (next) =>
        this.http.request<Paginated<Runtime>>({
          method: "GET",
          path: "/v1/runtimes",
          query: { ...params, next } as unknown as Record<string, unknown>,
        }),
      params.next,
    );
  }

  get(id: Uuid, params: { project_id?: Uuid }): Promise<Runtime> {
    return this.http.request<Runtime>({
      method: "GET",
      path: `/v1/runtimes/${encodeURIComponent(id)}`,
      query: params as Record<string, unknown>,
    });
  }

  create(input: RuntimeCreate): Promise<Runtime> {
    return this.http.request<Runtime>({
      method: "POST",
      path: "/v1/runtimes",
      body: input,
    });
  }

  update(id: Uuid, input: RuntimeUpdate): Promise<Runtime> {
    return this.http.request<Runtime>({
      method: "PATCH",
      path: `/v1/runtimes/${encodeURIComponent(id)}`,
      body: input,
    });
  }

  delete(id: Uuid): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/v1/runtimes/${encodeURIComponent(id)}`,
      expect: "empty",
    });
  }

  /** Resolve a name to a runtime by querying `/v1/runtimes?name=…`. */
  async resolveByName(name: string, projectId?: Uuid): Promise<Runtime> {
    for await (const r of this.list({
      project_id: projectId,
      name,
      limit: 2,
    })) {
      if (r.name === name) return r;
    }
    throw new NotFoundError({
      message: `Runtime '${name}' not found${projectId ? ` in project ${projectId}` : ""}`,
      status: 404,
      code: "not_found",
    });
  }

  /** POST `/v1/runtimes/{id}/run` and wrap the result in a `Runner`. */
  async runById(id: Uuid, opts?: RunRequest): Promise<Runner> {
    const spec = await this.http.request<RunnerSpec>({
      method: "POST",
      path: `/v1/runtimes/${encodeURIComponent(id)}/run`,
      body: toRunBody(opts) ?? {},
    });
    const source: RunnerSource = {
      kind: "runtime",
      id,
      options: opts,
    };
    return new Runner(this.client, source, spec);
  }

  async activateById(
    id: Uuid,
    params?: { project_id?: Uuid },
  ): Promise<Runtime> {
    return this.http.request<Runtime>({
      method: "POST",
      path: `/v1/runtimes/${encodeURIComponent(id)}/activate`,
      query: params as Record<string, unknown> | undefined,
      body: {},
    });
  }
}

/**
 * Handle returned by `client.runtimes(idOrName)`. Resolves the underlying
 * runtime id lazily — if you pass a UUID, no extra lookup happens; if you
 * pass a name, the first call that needs the id will hit
 * `/v1/runtimes?name=…`.
 */
export class RuntimeHandle {
  private resolvedId: Uuid | null;
  private readonly pinnedRecipeId: Uuid | null;

  constructor(
    private readonly api: RuntimesApi,
    private readonly client: IntrospectionClient,
    private readonly idOrName: string,
    pinnedRecipeId: Uuid | null = null,
  ) {
    this.resolvedId = isUuid(idOrName) ? idOrName : null;
    this.pinnedRecipeId = pinnedRecipeId;
  }

  private async resolveId(): Promise<Uuid> {
    if (this.resolvedId) return this.resolvedId;
    const runtime = await this.api.resolveByName(
      this.idOrName,
      this.client.projectId,
    );
    this.resolvedId = runtime.id;
    return runtime.id;
  }

  /**
   * Pin to a specific recipe — canary a previous version. Subsequent
   * `.run()` calls on the returned handle open a runner against the
   * runtime row in this name whose `recipe_id` matches `recipe.id`
   * (resolved server-side by CP).
   *
   * Returns a new child {@link RuntimeHandle}; the original handle is
   * unaffected. Accepts a {@link Recipe} object (uses `.id`) or a
   * recipe id string.
   */
  pin(recipe: Recipe | string): RuntimeHandle {
    const recipeId = typeof recipe === "string" ? recipe : recipe.id;
    return new RuntimeHandle(this.api, this.client, this.idOrName, recipeId);
  }

  async run(opts?: RunRequest): Promise<Runner> {
    const id = await this.resolveId();
    const merged: RunRequest | undefined =
      this.pinnedRecipeId !== null
        ? { ...(opts ?? {}), recipe_id: this.pinnedRecipeId }
        : opts;
    return this.api.runById(id, merged);
  }

  async activate(params?: { projectId?: Uuid }): Promise<Runtime> {
    const id = await this.resolveId();
    return this.api.activateById(id, { project_id: params?.projectId });
  }
}

/**
 * Callable hybrid: `client.runtimes` exposes the CRUD methods of
 * `RuntimesApi` AND can be invoked as a function returning a
 * `RuntimeHandle`. Realised by `attachRuntimes` below.
 */
export type RuntimeHandleFactory = (idOrName: string) => RuntimeHandle;

export function attachRuntimes(
  client: IntrospectionClient,
  http: HttpClient,
): RuntimesApi & RuntimeHandleFactory {
  const api = new RuntimesApi(http, client);
  const factory: RuntimeHandleFactory = (idOrName: string) =>
    new RuntimeHandle(api, client, idOrName);
  // Mount the API methods on the factory function. Using bound copies so
  // the methods can be invoked off the proxy without losing `this`.
  const hybrid = factory as RuntimesApi & RuntimeHandleFactory;
  hybrid.list = api.list.bind(api);
  hybrid.get = api.get.bind(api);
  hybrid.create = api.create.bind(api);
  hybrid.update = api.update.bind(api);
  hybrid.delete = api.delete.bind(api);
  hybrid.resolveByName = api.resolveByName.bind(api);
  hybrid.runById = api.runById.bind(api);
  hybrid.activateById = api.activateById.bind(api);
  return hybrid;
}
