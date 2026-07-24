import type {
  Paginated,
  RunRequest,
  RunnerSpec,
  RuntimeVersion,
  RuntimeVersionListParams,
  Uuid,
} from "@introspection-sdk/types";
import { Paginator, cursorPaginate } from "../pagination.js";
import type { ResourceHttpClient } from "./types.js";

export type RuntimeRunRequest =
  | (RunRequest & { runtime: string; runtime_id?: never })
  | (RunRequest & { runtime?: never; runtime_id: Uuid });

export type RuntimeRunnerWrapper<TRunner> = (spec: RunnerSpec) => TRunner;

/**
 * Shared read/run client for `/v1/runtimes`. Runtime lifecycle and environment
 * routing are operator concerns handled by the CLI and platform. Callers
 * supply the environment-specific runner constructor.
 */
export class RuntimesClient<TRunner> {
  constructor(
    private readonly http: ResourceHttpClient,
    private readonly wrapRunner: RuntimeRunnerWrapper<TRunner>,
  ) {}

  /**
   * List runtimes matching `params`. `await` the result for the first
   * page, or `for await` it to stream every runtime across pages.
   */
  list(params: RuntimeVersionListParams = {}): Paginator<RuntimeVersion> {
    return cursorPaginate(
      (next) =>
        this.http.request<Paginated<RuntimeVersion>>({
          method: "GET",
          path: "/v1/runtimes",
          query: { ...params, next } as Record<string, unknown>,
        }),
      params.next,
    );
  }

  get(id: Uuid, params?: { project?: string }): Promise<RuntimeVersion> {
    return this.http.request<RuntimeVersion>({
      method: "GET",
      path: `/v1/runtimes/${encodeURIComponent(id)}`,
      query: params as Record<string, unknown> | undefined,
    });
  }

  /** Run either a stable Runtime or one exact immutable Runtime version. */
  async run(request: RuntimeRunRequest): Promise<TRunner> {
    return this.wrapRunner(await this.postRun(request));
  }

  /** Internal wire operation shared by server-side runtime adapters. */
  protected postRun(request: RuntimeRunRequest): Promise<RunnerSpec> {
    return this.http.request<RunnerSpec>({
      method: "POST",
      path: "/v1/runtimes/run",
      body: request,
    });
  }
}

export { RuntimesClient as RuntimesApi };
