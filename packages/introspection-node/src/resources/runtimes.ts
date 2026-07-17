import type {
  Paginated,
  RunRequest,
  RunnerSpec,
  Uuid,
} from "@introspection-sdk/types";
import { NotFoundError } from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import type { IntrospectionClient } from "../client.js";
import { Runner } from "../runner.js";
import { cursorPaginate } from "../pagination.js";

interface ResolvedRuntime {
  id: Uuid;
}

interface RuntimeRunRequestBody {
  identity?: RunRequest["identity"];
  caller?: RunRequest["caller"];
  agent_name?: string;
  ttl_seconds?: number;
  scope?: string;
}

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

class RuntimesApi {
  constructor(
    private readonly http: HttpClient,
    private readonly client: IntrospectionClient,
  ) {}

  private async resolve(ref: string): Promise<ResolvedRuntime> {
    const matches = cursorPaginate(
      (next) =>
        this.http.request<Paginated<ResolvedRuntime>>({
          method: "GET",
          path: "/v1/runtimes",
          query: { runtime: ref, only_active: true, limit: 1, next },
        }),
      undefined,
    );
    for await (const match of matches) return match;
    throw new NotFoundError({
      message: `Runtime '${ref}' not found`,
      status: 404,
      code: "not_found",
    });
  }

  async run(ref: string, opts?: RunRequest): Promise<Runner> {
    const { id } = await this.resolve(ref);
    const spec = await this.http.request<RunnerSpec>({
      method: "POST",
      path: `/v1/runtimes/${encodeURIComponent(id)}/run`,
      body: toRunBody(opts),
    });
    return new Runner(
      this.client,
      { kind: "runtime", id, options: opts },
      spec,
    );
  }
}

export class RuntimeHandle {
  constructor(
    private readonly api: RuntimesApi,
    private readonly ref: string,
  ) {}

  run(opts?: RunRequest): Promise<Runner> {
    return this.api.run(this.ref, opts);
  }
}

export type RuntimeHandleFactory = (ref: string) => RuntimeHandle;

export function attachRuntimes(
  client: IntrospectionClient,
  http: HttpClient,
): RuntimeHandleFactory {
  const api = new RuntimesApi(http, client);
  return (ref: string) => new RuntimeHandle(api, ref);
}
