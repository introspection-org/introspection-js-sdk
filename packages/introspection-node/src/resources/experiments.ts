import type {
  Experiment,
  ExperimentCreate,
  ExperimentListParams,
  ExperimentUpdate,
  Paginated,
  RunRequest,
  RunnerSpec,
  Uuid,
} from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import type { IntrospectionClient } from "../client.js";
import { Paginator, cursorPaginate } from "../pagination.js";
import { Runner } from "../runner.js";

export type ExperimentRunRequest = Omit<RunRequest, "environment">;

interface ExperimentRunRequestBody {
  identity?: {
    user_id?: string;
    anonymous_id?: string;
    conversation_id?: string;
  };
  caller?: RunRequest["caller"];
  agent_name?: string;
  ttl_seconds?: number;
  scope?: string;
  bindings_required?: boolean;
}

function toRunBody(
  opts?: ExperimentRunRequest,
): ExperimentRunRequestBody | undefined {
  if (!opts) return undefined;
  const out: ExperimentRunRequestBody = {};
  if (opts.identity) out.identity = opts.identity;
  if (opts.caller) out.caller = opts.caller;
  if (opts.agent_name !== undefined) out.agent_name = opts.agent_name;
  if (opts.ttl_seconds !== undefined) out.ttl_seconds = opts.ttl_seconds;
  if (opts.scope !== undefined) out.scope = opts.scope;
  if (opts.bindings_required !== undefined)
    out.bindings_required = opts.bindings_required;
  return out;
}

export class ExperimentsApi {
  constructor(
    private readonly http: HttpClient,
    private readonly client: IntrospectionClient,
  ) {}

  /**
   * List experiments matching `params`. `await` the result for the first
   * page, or `for await` it to stream every experiment across pages
   * (fetched lazily — `limit` sets the page size, `next` the starting
   * cursor; stop early to stop fetching).
   */
  list(params: ExperimentListParams): Paginator<Experiment> {
    return cursorPaginate(
      (next) =>
        this.http.request<Paginated<Experiment>>({
          method: "GET",
          path: "/v1/experiments",
          query: { ...params, next } as unknown as Record<string, unknown>,
        }),
      params.next,
    );
  }

  get(id: Uuid): Promise<Experiment> {
    return this.http.request<Experiment>({
      method: "GET",
      path: `/v1/experiments/${encodeURIComponent(id)}`,
    });
  }

  create(input: ExperimentCreate): Promise<Experiment> {
    return this.http.request<Experiment>({
      method: "POST",
      path: "/v1/experiments",
      body: input,
    });
  }

  update(id: Uuid, input: ExperimentUpdate): Promise<Experiment> {
    return this.http.request<Experiment>({
      method: "PATCH",
      path: `/v1/experiments/${encodeURIComponent(id)}`,
      body: input,
    });
  }

  delete(id: Uuid): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/v1/experiments/${encodeURIComponent(id)}`,
      expect: "empty",
    });
  }

  start(id: Uuid): Promise<Experiment> {
    return this.http.request<Experiment>({
      method: "POST",
      path: `/v1/experiments/${encodeURIComponent(id)}/start`,
      body: {},
    });
  }

  end(id: Uuid): Promise<Experiment> {
    return this.http.request<Experiment>({
      method: "POST",
      path: `/v1/experiments/${encodeURIComponent(id)}/end`,
      body: {},
    });
  }

  cancel(id: Uuid): Promise<Experiment> {
    return this.http.request<Experiment>({
      method: "POST",
      path: `/v1/experiments/${encodeURIComponent(id)}/cancel`,
      body: {},
    });
  }

  async run(id: Uuid, opts?: ExperimentRunRequest): Promise<Runner> {
    const body = toRunBody(opts) ?? {};
    const spec = await this.http.request<RunnerSpec>({
      method: "POST",
      path: `/v1/experiments/${encodeURIComponent(id)}/run`,
      query: opts?.project ? { project: opts.project } : undefined,
      body,
    });
    return new Runner(this.client, spec);
  }
}

export function attachExperiments(
  client: IntrospectionClient,
  http: HttpClient,
): ExperimentsApi {
  return new ExperimentsApi(http, client);
}
