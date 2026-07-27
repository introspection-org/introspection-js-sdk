import { RuntimesClient, isUuid } from "@introspection-sdk/http";
import type { RunRequest, RunnerSpec, Uuid } from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import type { IntrospectionClient } from "../client.js";
import { Runner } from "../runner.js";

export { isUuid };

/**
 * Node-only options for opening a runner directly.
 *
 * `developmentAuthorization` is a short-lived proof produced by
 * `introspection dev`. It is sent only on this Control Plane `/run` request;
 * a {@link Runner} retains it privately only to authorize later Control Plane
 * refreshes. It is never included in request bodies or Data Plane calls.
 */
export interface OpenRunnerOptions extends RunRequest {
  developmentAuthorization?: string;
}

export class RuntimesApi extends RuntimesClient<Runner> {
  constructor(
    private readonly nodeHttp: HttpClient,
    private readonly client: IntrospectionClient,
  ) {
    super(nodeHttp, (source, spec) => new Runner(this.client, source, spec));
  }

  override openRunner(id: Uuid, opts?: OpenRunnerOptions): Promise<RunnerSpec> {
    const developmentAuthorization = normalizedDevelopmentAuthorization(opts);
    return this.nodeHttp.request<RunnerSpec>({
      method: "POST",
      path: `/v1/runtimes/${encodeURIComponent(id)}/run`,
      body: toRunBody(opts),
      headers: developmentAuthorization
        ? {
            "Introspection-Development-Authorization": `Bearer ${developmentAuthorization}`,
          }
        : undefined,
    });
  }

  override async runById(id: Uuid, opts?: OpenRunnerOptions): Promise<Runner> {
    const spec = await this.openRunner(id, opts);
    return new Runner(
      this.client,
      {
        kind: "runtime",
        id,
        options: withoutDevelopmentAuthorization(opts),
      },
      spec,
      normalizedDevelopmentAuthorization(opts),
    );
  }
}

export class RuntimeHandle {
  private resolvedId: Uuid | null = null;

  constructor(
    private readonly api: RuntimesApi,
    private readonly runtime: string,
  ) {}

  private async resolveId(): Promise<Uuid> {
    if (this.resolvedId) return this.resolvedId;
    const resolved = await this.api.resolve(this.runtime);
    this.resolvedId = resolved.id;
    return resolved.id;
  }

  async run(opts?: OpenRunnerOptions): Promise<Runner> {
    return this.api.runById(await this.resolveId(), opts);
  }
}

export type RuntimeHandleFactory = (runtime: string) => RuntimeHandle;

export function attachRuntimes(
  client: IntrospectionClient,
  http: HttpClient,
): RuntimesApi & RuntimeHandleFactory {
  const api = new RuntimesApi(http, client);
  const factory: RuntimeHandleFactory = (runtime: string) =>
    new RuntimeHandle(api, runtime);
  const hybrid = factory as RuntimesApi & RuntimeHandleFactory;
  hybrid.list = api.list.bind(api);
  hybrid.get = api.get.bind(api);
  hybrid.resolve = api.resolve.bind(api);
  hybrid.runById = api.runById.bind(api);
  hybrid.openRunner = api.openRunner.bind(api);
  return hybrid;
}

function toRunBody(opts?: RunRequest): Record<string, unknown> {
  if (!opts) return {};
  const out: Record<string, unknown> = {};
  if (opts.identity) out.identity = opts.identity;
  if (opts.caller) out.caller = opts.caller;
  if (opts.agent_name !== undefined) out.agent_name = opts.agent_name;
  if (opts.ttl_seconds !== undefined) out.ttl_seconds = opts.ttl_seconds;
  if (opts.scope !== undefined) out.scope = opts.scope;
  return out;
}

function withoutDevelopmentAuthorization(
  opts?: OpenRunnerOptions,
): RunRequest | undefined {
  if (!opts) return undefined;
  const runRequest = { ...opts };
  delete runRequest.developmentAuthorization;
  return runRequest;
}

function normalizedDevelopmentAuthorization(
  opts?: OpenRunnerOptions,
): string | undefined {
  const proof = opts?.developmentAuthorization?.trim();
  return proof || undefined;
}
