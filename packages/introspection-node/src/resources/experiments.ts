import type { RunRequest, RunnerSpec, Uuid } from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import type { IntrospectionClient } from "../client.js";
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

class ExperimentsApi {
  constructor(
    private readonly http: HttpClient,
    private readonly client: IntrospectionClient,
  ) {}

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
}

export type ExperimentHandleFactory = (id: Uuid) => ExperimentHandle;

export function attachExperiments(
  client: IntrospectionClient,
  http: HttpClient,
): ExperimentHandleFactory {
  const api = new ExperimentsApi(http, client);
  return (id: Uuid) => new ExperimentHandle(api, id);
}
