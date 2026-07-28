import {
  RuntimeHandle,
  RuntimesClient,
  attachRuntimes as attachSharedRuntimes,
  isUuid,
  type RuntimeHandleFactory as SharedRuntimeHandleFactory,
} from "@introspection-sdk/http";
import type { RunRequest, RunnerSpec, Uuid } from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import type { IntrospectionClient } from "../client.js";
import { Runner } from "../runner.js";
import { withDevTarget } from "../dev-target.js";

export { RuntimeHandle, isUuid };

export class RuntimesApi extends RuntimesClient<Runner> {
  constructor(
    http: HttpClient,
    private readonly client: IntrospectionClient,
  ) {
    super(http, (source, spec) => new Runner(this.client, source, spec));
  }

  /**
   * Normalize the request *before* `super.runById` stores it on the runner
   * source, so a later re-mint (`runner.refresh()`) replays the same target
   * rather than silently dropping back to ambiguous routing.
   */
  override async runById(id: Uuid, opts?: RunRequest): Promise<Runner> {
    return super.runById(id, withDevTarget(opts));
  }

  /** The same default for callers that open a spec without a runner. */
  override openRunner(id: Uuid, opts?: RunRequest): Promise<RunnerSpec> {
    return super.openRunner(id, withDevTarget(opts));
  }
}

export type RuntimeHandleFactory = SharedRuntimeHandleFactory<Runner>;

export function attachRuntimes(
  client: IntrospectionClient,
  http: HttpClient,
): RuntimesApi & RuntimeHandleFactory {
  const api = new RuntimesApi(http, client);
  return attachSharedRuntimes(api) as RuntimesApi & RuntimeHandleFactory;
}
