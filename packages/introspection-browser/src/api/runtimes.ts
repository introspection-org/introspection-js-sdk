import {
  RuntimeHandle,
  RuntimesClient,
  attachRuntimes,
  isUuid,
  type RuntimeHandleFactory,
  type RuntimeRunRequestBody,
} from "@introspection-sdk/http";
import type { BrowserApiHttpClient } from "./http.js";
import { BrowserRunner, type BrowserRunnerOwner } from "./runner.js";

export { isUuid };
export type { RuntimeRunRequestBody as BrowserRuntimeRunRequestBody };

export class BrowserRuntimesClient extends RuntimesClient<BrowserRunner> {
  constructor(http: BrowserApiHttpClient, owner: BrowserRunnerOwner) {
    super(http, (source, spec) => new BrowserRunner(owner, source, spec));
  }
}

export { RuntimeHandle as BrowserRuntimeHandle };

export type BrowserRuntimeHandleFactory = RuntimeHandleFactory<BrowserRunner>;

export function attachBrowserRuntimes(
  http: BrowserApiHttpClient,
  owner: BrowserRunnerOwner,
): BrowserRuntimesClient & BrowserRuntimeHandleFactory {
  const api = new BrowserRuntimesClient(http, owner);
  return attachRuntimes(api) as BrowserRuntimesClient &
    BrowserRuntimeHandleFactory;
}
