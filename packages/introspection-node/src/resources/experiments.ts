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
import { Runner, type RunnerSource } from "../runner.js";

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
}

function toRunBody(opts?: RunRequest): ExperimentRunRequestBody | undefined {
  if (!opts) return undefined;
  const out: ExperimentRunRequestBody = {};
  if (opts.identity) out.identity = opts.identity;
  if (opts.caller) out.caller = opts.caller;
  if (opts.agent_name !== undefined) out.agent_name = opts.agent_name;
  if (opts.ttl_seconds !== undefined) out.ttl_seconds = opts.ttl_seconds;
  if (opts.scope !== undefined) out.scope = opts.scope;
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

  startById(id: Uuid): Promise<Experiment> {
    return this.http.request<Experiment>({
      method: "POST",
      path: `/v1/experiments/${encodeURIComponent(id)}/start`,
      body: {},
    });
  }

  endById(id: Uuid): Promise<Experiment> {
    return this.http.request<Experiment>({
      method: "POST",
      path: `/v1/experiments/${encodeURIComponent(id)}/end`,
      body: {},
    });
  }

  cancelById(id: Uuid): Promise<Experiment> {
    return this.http.request<Experiment>({
      method: "POST",
      path: `/v1/experiments/${encodeURIComponent(id)}/cancel`,
      body: {},
    });
  }

  async runById(id: Uuid, opts?: RunRequest): Promise<Runner> {
    const spec = await this.http.request<RunnerSpec>({
      method: "POST",
      path: `/v1/experiments/${encodeURIComponent(id)}/run`,
      body: toRunBody(opts) ?? {},
    });
    const source: RunnerSource = {
      kind: "experiment",
      id,
      options: opts,
    };
    return new Runner(this.client, source, spec);
  }
}

export class ExperimentHandle {
  constructor(
    private readonly api: ExperimentsApi,
    private readonly id: Uuid,
  ) {}

  run(opts?: RunRequest): Promise<Runner> {
    return this.api.runById(this.id, opts);
  }

  start(): Promise<Experiment> {
    return this.api.startById(this.id);
  }

  end(): Promise<Experiment> {
    return this.api.endById(this.id);
  }

  cancel(): Promise<Experiment> {
    return this.api.cancelById(this.id);
  }
}

export type ExperimentHandleFactory = (id: Uuid) => ExperimentHandle;

export function attachExperiments(
  client: IntrospectionClient,
  http: HttpClient,
): ExperimentsApi & ExperimentHandleFactory {
  const api = new ExperimentsApi(http, client);
  const factory: ExperimentHandleFactory = (id: Uuid) =>
    new ExperimentHandle(api, id);
  const hybrid = factory as ExperimentsApi & ExperimentHandleFactory;
  hybrid.list = api.list.bind(api);
  hybrid.get = api.get.bind(api);
  hybrid.create = api.create.bind(api);
  hybrid.update = api.update.bind(api);
  hybrid.delete = api.delete.bind(api);
  hybrid.startById = api.startById.bind(api);
  hybrid.endById = api.endById.bind(api);
  hybrid.cancelById = api.cancelById.bind(api);
  hybrid.runById = api.runById.bind(api);
  return hybrid;
}
