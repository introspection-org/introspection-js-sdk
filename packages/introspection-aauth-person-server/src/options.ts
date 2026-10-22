import type { AAuthLogger, FetchLike } from "@introspection-sdk/aauth-protocol";

import type {
  Agent,
  Approval,
  Budget,
  Directory,
  Mission,
  Person,
  Store,
} from "./types.js";

/** The tenant a request that names none is under, unless `defaultTenant` or `requireTenant` says otherwise. */
export const DEFAULT_TENANT = "default";

export interface PersonServerOptions {
  /** This Person Server's identifier: `https://host`, no port or path. */
  issuer: string;
  /** Who it speaks for, and who decides for them. */
  directory: Directory;
  /** Agent providers whose agents may ask (their `iss`). */
  trustedAgentProviders: readonly string[] | ((issuer: string) => boolean);
  /** PKCS#8 Ed25519 PEM. Unset, a fresh key per process. */
  signingKey?: string;
  /** Derives each person's directed `sub` per audience. Unset, a fresh secret per process. */
  subjectSecret?: string;
  /** Where state is kept; in memory by default. */
  store?: Store;
  /** The tenant a request that names none is under. Default: `DEFAULT_TENANT`. */
  defaultTenant?: string;
  /** Every request names its tenant: there is no default, and one naming none is a `400`. */
  requireTenant?: boolean;
  /** Where the routes live under the issuer, e.g. `/ps`. Default: the root. */
  basePath?: string;
  /** Called with each new approval, to reach whoever decides. */
  onApproval?: (approval: Approval) => void | Promise<void>;
  /** Called with each approval once decided. */
  onDecision?: (approval: Approval) => void | Promise<void>;
  /** Called with each token issued. */
  onIssued?: (issued: Issued) => void | Promise<void>;
  /** Bearer token for the management routes (`/consent`, `/missions`). Unset, they are off. */
  adminToken?: string;
  name?: string;
  description?: string;
  tokenTtlSeconds?: number;
  missionTtlSeconds?: number;
  approvalTtlSeconds?: number;
  retryAfterSeconds?: number;
  /** For discovery and R3 reads; global fetch by default. */
  fetch?: FetchLike;
  /** Where its decision records go; nowhere by default. */
  logger?: AAuthLogger;
  /** Seconds since the epoch; for tests. */
  now?: () => number;
}

/** A token this Person Server issued, as `onIssued` reports it. */
export interface Issued {
  type: "person_token" | "auth_token";
  agent: Agent;
  person: Person;
  resource: string;
  mission?: Mission;
  budget?: Budget;
  /** When the resource's Access Server issued it, not this Person Server: that AS. */
  access_server?: string;
}
