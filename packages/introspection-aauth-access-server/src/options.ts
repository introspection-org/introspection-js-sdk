import type { AAuthLogger, FetchLike } from "@introspection-sdk/aauth-protocol";

import type { IssuedAccess, PendingAccess, Policy } from "./types.js";

export interface AccessServerOptions {
  /** This Access Server's identifier: `https://host`, no port or path. */
  issuer: string;
  /** The resources it decides for (their `iss`). Verifying a resource token fetches its keys, so the list is closed. */
  resources: readonly string[];
  /** The Person Servers it takes token requests from. */
  personServers: readonly string[];
  /** The agent providers whose agents it serves. */
  agentProviders: readonly string[];
  /** The resource's policy. */
  policy: Policy;
  /** PKCS#8 Ed25519 PEM. Unset, a fresh key per process. */
  signingKey?: string;
  kid?: string;
  name?: string;
  description?: string;
  /** Where the routes live under the issuer, e.g. `/as`. Default: the root. */
  basePath?: string;
  /** At most an hour. */
  tokenTtlSeconds?: number;
  /** How long a request may wait on a decision. */
  pendingTtlSeconds?: number;
  retryAfterSeconds?: number;
  /** Called with each request the policy waits on, to reach whoever decides. */
  onPending?: (pending: PendingAccess) => void | Promise<void>;
  /** Called with each auth token issued. */
  onIssued?: (issued: IssuedAccess) => void | Promise<void>;
  /** For discovery and R3 reads; global fetch by default. */
  fetch?: FetchLike;
  /** Where its decision records go; nowhere by default. */
  logger?: AAuthLogger;
  /** Seconds since the epoch; for tests. */
  now?: () => number;
}
