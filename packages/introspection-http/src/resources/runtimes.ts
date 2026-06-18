import type {
  Paginated,
  Recipe,
  RunRequest,
  RunnerSpec,
  Runtime,
  RuntimeCreate,
  RuntimeListParams,
  RuntimeUpdate,
  Uuid,
} from "@introspection-sdk/types";
import { NotFoundError } from "@introspection-sdk/types";
import { Paginator, cursorPaginate } from "../pagination.js";
import type { ResourceHttpClient } from "./types.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export interface RuntimeRunRequestBody {
  identity?: RunRequest["identity"];
  caller?: RunRequest["caller"];
  ttl_seconds?: number;
  recipe_id?: Uuid;
}

export interface RuntimeRunnerSource {
  kind: "runtime";
  id: Uuid;
  options?: RunRequest;
}

export type RuntimeRunnerFactory<TRunner> = (
  source: RuntimeRunnerSource,
  spec: RunnerSpec,
) => TRunner;

function toRunBody(opts?: RunRequest): RuntimeRunRequestBody {
  if (!opts) return {};
  const out: RuntimeRunRequestBody = {};
  if (opts.identity) out.identity = opts.identity;
  if (opts.caller) out.caller = opts.caller;
  if (opts.ttl_seconds !== undefined) out.ttl_seconds = opts.ttl_seconds;
  if (opts.recipe_id !== undefined) out.recipe_id = opts.recipe_id;
  return out;
}

/**
 * Shared `/v1/runtimes` client. Runtime CRUD and name resolution are
 * isomorphic; callers supply the environment-specific runner constructor.
 */
export class RuntimesClient<TRunner> {
  constructor(
    private readonly http: ResourceHttpClient,
    private readonly createRunner: RuntimeRunnerFactory<TRunner>,
  ) {}

  /**
   * List runtimes matching `params`. `await` the result for the first
   * page, or `for await` it to stream every runtime across pages.
   */
  list(params: RuntimeListParams = {}): Paginator<Runtime> {
    return cursorPaginate(
      (next) =>
        this.http.request<Paginated<Runtime>>({
          method: "GET",
          path: "/v1/runtimes",
          query: { ...params, next } as Record<string, unknown>,
        }),
      params.next,
    );
  }

  get(id: Uuid, params?: { project_id?: Uuid }): Promise<Runtime> {
    return this.http.request<Runtime>({
      method: "GET",
      path: `/v1/runtimes/${encodeURIComponent(id)}`,
      query: params as Record<string, unknown> | undefined,
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
    for await (const runtime of this.list({
      project_id: projectId,
      name,
      limit: 2,
    })) {
      if (runtime.name === name) return runtime;
    }
    throw new NotFoundError({
      message: `Runtime '${name}' not found${projectId ? ` in project ${projectId}` : ""}`,
      status: 404,
      code: "not_found",
    });
  }

  /** POST `/v1/runtimes/{id}/run` and wrap the result in a runner. */
  async runById(id: Uuid, opts?: RunRequest): Promise<TRunner> {
    const source: RuntimeRunnerSource = {
      kind: "runtime",
      id,
      options: opts,
    };
    const spec = await this.openRunner(id, opts);
    return this.createRunner(source, spec);
  }

  openRunner(id: Uuid, opts?: RunRequest): Promise<RunnerSpec> {
    return this.http.request<RunnerSpec>({
      method: "POST",
      path: `/v1/runtimes/${encodeURIComponent(id)}/run`,
      body: toRunBody(opts),
    });
  }

  activateById(id: Uuid, params?: { project_id?: Uuid }): Promise<Runtime> {
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
 * runtime id lazily.
 */
export class RuntimeHandle<TRunner> {
  private resolvedId: Uuid | null;
  private readonly pinnedRecipeId: Uuid | null;

  constructor(
    private readonly api: RuntimesClient<TRunner>,
    private readonly idOrName: string,
    pinnedRecipeId: Uuid | null = null,
  ) {
    this.resolvedId = isUuid(idOrName) ? idOrName : null;
    this.pinnedRecipeId = pinnedRecipeId;
  }

  private async resolveId(): Promise<Uuid> {
    if (this.resolvedId) return this.resolvedId;
    const runtime = await this.api.resolveByName(this.idOrName);
    this.resolvedId = runtime.id;
    return runtime.id;
  }

  pin(recipe: Recipe | string): RuntimeHandle<TRunner> {
    const recipeId = typeof recipe === "string" ? recipe : recipe.id;
    return new RuntimeHandle(this.api, this.idOrName, recipeId);
  }

  async run(opts?: RunRequest): Promise<TRunner> {
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

export type RuntimeHandleFactory<TRunner> = (
  idOrName: string,
) => RuntimeHandle<TRunner>;

export function attachRuntimes<TRunner>(
  api: RuntimesClient<TRunner>,
): RuntimesClient<TRunner> & RuntimeHandleFactory<TRunner> {
  const factory: RuntimeHandleFactory<TRunner> = (idOrName: string) =>
    new RuntimeHandle(api, idOrName);
  const hybrid = factory as RuntimesClient<TRunner> &
    RuntimeHandleFactory<TRunner>;
  hybrid.list = api.list.bind(api);
  hybrid.get = api.get.bind(api);
  hybrid.create = api.create.bind(api);
  hybrid.update = api.update.bind(api);
  hybrid.delete = api.delete.bind(api);
  hybrid.resolveByName = api.resolveByName.bind(api);
  hybrid.runById = api.runById.bind(api);
  hybrid.openRunner = api.openRunner.bind(api);
  hybrid.activateById = api.activateById.bind(api);
  return hybrid;
}

export { RuntimesClient as RuntimesApi };
