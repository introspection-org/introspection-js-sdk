import type {
  Paginated,
  RunRequest,
  RunnerSpec,
  Runtime,
  RuntimeListParams,
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
  project?: RunRequest["project"];
  environment?: RunRequest["environment"];
  identity?: RunRequest["identity"];
  caller?: RunRequest["caller"];
  agent_name?: string;
  ttl_seconds?: number;
  scope?: string;
}

export interface RuntimeRunnerSource {
  kind: "runtime";
  /** Original stable selector or exact Runtime version ID. */
  id: Uuid;
  /** Omitted sources from older callers are exact Runtime version IDs. */
  selector?: "runtime" | "runtime_id";
  options?: RunRequest;
}

export type RuntimeRunnerFactory<TRunner> = (
  source: RuntimeRunnerSource,
  spec: RunnerSpec,
) => TRunner;

function toRunBody(opts?: RunRequest): RuntimeRunRequestBody {
  if (!opts) return {};
  const out: RuntimeRunRequestBody = {};
  if (opts.project !== undefined) out.project = opts.project;
  if (opts.environment !== undefined) out.environment = opts.environment;
  if (opts.identity) out.identity = opts.identity;
  if (opts.caller) out.caller = opts.caller;
  if (opts.agent_name !== undefined) out.agent_name = opts.agent_name;
  if (opts.ttl_seconds !== undefined) out.ttl_seconds = opts.ttl_seconds;
  if (opts.scope !== undefined) out.scope = opts.scope;
  return out;
}

const runStable = Symbol("runStable");

/**
 * Shared read/run client for `/v1/runtimes`. Runtime lifecycle and environment
 * routing are operator concerns handled by the CLI and platform. Callers
 * supply the environment-specific runner constructor.
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

  /** Run one exact immutable Runtime version and wrap the result. */
  async runById(id: Uuid, opts?: RunRequest): Promise<TRunner> {
    const source: RuntimeRunnerSource = {
      kind: "runtime",
      id,
      selector: "runtime_id",
      options: opts,
    };
    const spec = await this.openRunner(id, opts);
    return this.createRunner(source, spec);
  }

  /** Open a raw Runner for one exact immutable Runtime version. */
  openRunner(id: Uuid, opts?: RunRequest): Promise<RunnerSpec> {
    return this.postRun({ runtime_id: id }, opts);
  }

  async [runStable](runtime: string, opts?: RunRequest): Promise<TRunner> {
    const source: RuntimeRunnerSource = {
      kind: "runtime",
      id: runtime,
      selector: "runtime",
      options: opts,
    };
    const spec = await this.postRun({ runtime }, opts);
    return this.createRunner(source, spec);
  }

  private postRun(
    selector: { runtime: string } | { runtime_id: Uuid },
    opts?: RunRequest,
  ): Promise<RunnerSpec> {
    return this.http.request<RunnerSpec>({
      method: "POST",
      path: "/v1/runtimes/run",
      body: { ...selector, ...toRunBody(opts) },
    });
  }
}

/**
 * Handle returned by `client.runtimes(runtime)`. The stable selector is sent
 * directly to Control Plane so selection and Runner creation are atomic.
 */
export class RuntimeHandle<TRunner> {
  constructor(
    private readonly api: RuntimesClient<TRunner>,
    private readonly runtime: string,
  ) {}

  async run(opts?: RunRequest): Promise<TRunner> {
    return this.api[runStable](this.runtime, opts);
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
  hybrid.resolve = api.resolve.bind(api);
  hybrid.runById = api.runById.bind(api);
  hybrid.openRunner = api.openRunner.bind(api);
  return hybrid;
}

export { RuntimesClient as RuntimesApi };
