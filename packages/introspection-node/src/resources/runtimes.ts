import {
  RuntimeHandle,
  RuntimesClient,
  attachRuntimes as attachSharedRuntimes,
  isUuid,
  type RuntimeHandleFactory as SharedRuntimeHandleFactory,
} from "@introspection-sdk/http";
import type { HttpClient } from "../http.js";
import type { IntrospectionClient } from "../client.js";
import { Runner } from "../runner.js";

export { RuntimeHandle, isUuid };

export class RuntimesApi extends RuntimesClient<Runner> {
  constructor(
    http: HttpClient,
    private readonly client: IntrospectionClient,
  ) {
    super(http, (source, spec) => new Runner(this.client, source, spec));
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
