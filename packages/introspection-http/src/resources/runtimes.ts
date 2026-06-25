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
 * Shared `/v1/runtimes` client. Runtime CRUD uses concrete runtime row IDs;
 * user-facing resolution uses runtime group slug or ID. Callers supply the
 * environment-specific runner constructor.
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

  get(id: Uuid, params?: { project?: string }): Promise<Runtime> {
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

  /**
   * Withdraw a runtime so it stops resolving as the active runtime for its
   * environment. In-flight sticky runs keep using it; new runs fall back to
   * the previous active runtime (or "none active" until a replacement is
   * promoted). Pass an optional human-readable `reason`.
   */
  yank(id: Uuid, reason?: string): Promise<Runtime> {
    return this.http.request<Runtime>({
      method: "PATCH",
      path: `/v1/runtimes/${encodeURIComponent(id)}`,
      body: { yanked: true, yanked_reason: reason },
    });
  }

  /** Reverse a {@link yank}, making the runtime eligible to resolve again. */
  unyank(id: Uuid): Promise<Runtime> {
    return this.http.request<Runtime>({
      method: "PATCH",
      path: `/v1/runtimes/${encodeURIComponent(id)}`,
      body: { yanked: false },
    });
  }

  /** Resolve a runtime group slug or ID by querying `/v1/runtimes?runtime=…`. */
  async resolve(runtime: string, project?: string): Promise<Runtime> {
    for await (const match of this.list({
      project,
      runtime,
      limit: 2,
    })) {
      return match;
    }
    throw new NotFoundError({
      message: `Runtime '${runtime}' not found${project ? ` in project ${project}` : ""}`,
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

  activateById(id: Uuid, params?: { project?: string }): Promise<Runtime> {
    return this.http.request<Runtime>({
      method: "POST",
      path: `/v1/runtimes/${encodeURIComponent(id)}/activate`,
      query: params as Record<string, unknown> | undefined,
      body: {},
    });
  }
}

/**
 * Handle returned by `client.runtimes(runtime)`. Resolves the underlying
 * runtime row ID lazily from a runtime group slug or ID.
 */
export class RuntimeHandle<TRunner> {
  private resolvedId: Uuid | null;
  private readonly pinnedRecipeId: Uuid | null;

  constructor(
    private readonly api: RuntimesClient<TRunner>,
    private readonly runtime: string,
    pinnedRecipeId: Uuid | null = null,
  ) {
    this.resolvedId = null;
    this.pinnedRecipeId = pinnedRecipeId;
  }

  private async resolveId(): Promise<Uuid> {
    if (this.resolvedId) return this.resolvedId;
    const resolved = await this.api.resolve(this.runtime);
    this.resolvedId = resolved.id;
    return resolved.id;
  }

  pin(recipe: Recipe | string): RuntimeHandle<TRunner> {
    const recipeId = typeof recipe === "string" ? recipe : recipe.id;
    return new RuntimeHandle(this.api, this.runtime, recipeId);
  }

  async run(opts?: RunRequest): Promise<TRunner> {
    const id = await this.resolveId();
    const merged: RunRequest | undefined =
      this.pinnedRecipeId !== null
        ? { ...(opts ?? {}), recipe_id: this.pinnedRecipeId }
        : opts;
    return this.api.runById(id, merged);
  }

  async activate(params?: { project?: string }): Promise<Runtime> {
    const id = await this.resolveId();
    return this.api.activateById(id, { project: params?.project });
  }
}

export type RuntimeHandleFactory<TRunner> = (
  runtime: string,
) => RuntimeHandle<TRunner>;

export function attachRuntimes<TRunner>(
  api: RuntimesClient<TRunner>,
): RuntimesClient<TRunner> & RuntimeHandleFactory<TRunner> {
  const factory: RuntimeHandleFactory<TRunner> = (runtime: string) =>
    new RuntimeHandle(api, runtime);
  const hybrid = factory as RuntimesClient<TRunner> &
    RuntimeHandleFactory<TRunner>;
  hybrid.list = api.list.bind(api);
  hybrid.get = api.get.bind(api);
  hybrid.create = api.create.bind(api);
  hybrid.update = api.update.bind(api);
  hybrid.delete = api.delete.bind(api);
  hybrid.yank = api.yank.bind(api);
  hybrid.unyank = api.unyank.bind(api);
  hybrid.resolve = api.resolve.bind(api);
  hybrid.runById = api.runById.bind(api);
  hybrid.openRunner = api.openRunner.bind(api);
  hybrid.activateById = api.activateById.bind(api);
  return hybrid;
}

export { RuntimesClient as RuntimesApi };
