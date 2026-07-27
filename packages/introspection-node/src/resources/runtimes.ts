import {
  RuntimeHandle,
  RuntimesClient,
  attachRuntimes as attachSharedRuntimes,
  isUuid,
  type RuntimeHandleFactory as SharedRuntimeHandleFactory,
} from "@introspection-sdk/http";
import type { RunRequest } from "@introspection-sdk/types";
import { userInfo } from "node:os";
import type { HttpClient } from "../http.js";
import type { IntrospectionClient } from "../client.js";
import { Runner } from "../runner.js";

export { RuntimeHandle, isUuid };

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

export class RuntimesApi extends RuntimesClient<Runner, OpenRunnerOptions> {
  constructor(http: HttpClient, client: IntrospectionClient) {
    super(
      http,
      (source, spec, options) =>
        new Runner(
          client,
          source,
          spec,
          normalizedDevelopmentAuthorization(options),
        ),
      {
        headers: (options) => {
          const proof = normalizedDevelopmentAuthorization(options);
          if (!proof) return undefined;
          const target = normalizedDevelopmentTarget();
          return {
            "Introspection-Development-Authorization": `Bearer ${proof}`,
            ...(target ? { "X-Introspection-Relay-Target": target } : {}),
          };
        },
      },
    );
  }
}

function normalizedDevelopmentTarget(): string | undefined {
  const target =
    process.env.INTROSPECTION_RELAY_TARGET?.trim() ||
    userInfo().username.trim();
  if (!target) return undefined;
  if (target.length > 128 || !/^[A-Za-z0-9._@-]+$/.test(target)) {
    throw new Error(
      "INTROSPECTION_RELAY_TARGET must be 1-128 letters, numbers, `.`, `_`, `@`, or `-`",
    );
  }
  return target;
}

export type RuntimeHandleFactory = SharedRuntimeHandleFactory<
  Runner,
  OpenRunnerOptions
>;

export function attachRuntimes(
  client: IntrospectionClient,
  http: HttpClient,
): RuntimesApi & RuntimeHandleFactory {
  const api = new RuntimesApi(http, client);
  return attachSharedRuntimes(api) as RuntimesApi & RuntimeHandleFactory;
}

function normalizedDevelopmentAuthorization(
  opts?: OpenRunnerOptions,
): string | undefined {
  const proof = opts?.developmentAuthorization?.trim();
  return proof || undefined;
}
