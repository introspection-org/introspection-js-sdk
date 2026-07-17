import type {
  Paginated,
  RunRequest,
  RunnerSpec,
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

interface ResolvedRuntime {
  id: Uuid;
}

export interface RuntimeRunRequestBody {
  identity?: RunRequest["identity"];
  caller?: RunRequest["caller"];
  agent_name?: string;
  ttl_seconds?: number;
  scope?: string;
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
  if (opts.agent_name !== undefined) out.agent_name = opts.agent_name;
  if (opts.ttl_seconds !== undefined) out.ttl_seconds = opts.ttl_seconds;
  if (opts.scope !== undefined) out.scope = opts.scope;
  return out;
}

/**
 * Shared runner opener. It resolves a configured runtime group slug or ID,
 * then calls the concrete runtime row's `/run` route. Management stays in the
 * CLI and frontend.
 */
export class RuntimesClient<TRunner> {
  constructor(
    private readonly http: ResourceHttpClient,
    private readonly createRunner: RuntimeRunnerFactory<TRunner>,
  ) {}

  private list(runtime: string): Paginator<ResolvedRuntime> {
    return cursorPaginate(
      (next) =>
        this.http.request<Paginated<ResolvedRuntime>>({
          method: "GET",
          path: "/v1/runtimes",
          query: { runtime, only_active: true, limit: 1, next },
        }),
      undefined,
    );
  }

  /** Resolve a runtime group slug or ID by querying `/v1/runtimes?runtime=…`. */
  async resolve(runtime: string): Promise<ResolvedRuntime> {
    for await (const match of this.list(runtime)) {
      return match;
    }
    throw new NotFoundError({
      message: `Runtime '${runtime}' not found`,
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
}

/**
 * Handle returned by `client.runtime(runtime)`. Resolves the underlying
 * runtime row ID lazily from a runtime group slug or ID.
 */
export class RuntimeHandle<TRunner> {
  private resolvedId: Uuid | null;

  constructor(
    private readonly api: RuntimesClient<TRunner>,
    private readonly runtime: string,
  ) {
    this.resolvedId = null;
  }

  private async resolveId(): Promise<Uuid> {
    if (this.resolvedId) return this.resolvedId;
    const resolved = await this.api.resolve(this.runtime);
    this.resolvedId = resolved.id;
    return resolved.id;
  }

  async run(opts?: RunRequest): Promise<TRunner> {
    const id = await this.resolveId();
    return this.api.runById(id, opts);
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
  hybrid.resolve = api.resolve.bind(api);
  hybrid.runById = api.runById.bind(api);
  hybrid.openRunner = api.openRunner.bind(api);
  return hybrid;
}

export { RuntimesClient as RuntimesApi };
