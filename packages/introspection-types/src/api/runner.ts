import type { IsoDate, Uuid } from "./common.js";

export interface RunnerIdentity {
  user_id: string | null;
  anonymous_id: string | null;
  conversation_id: string | null;
  /** Member tags asserted on the request; see {@link RunIdentityInput.tags}. */
  tags?: string[] | null;
  /**
   * Member metadata asserted on the request; see
   * {@link RunIdentityInput.metadata}. Echoed by the `/run` response only:
   * it is not carried on the session, so a refreshed session reports none.
   */
  metadata?: Record<string, string> | null;
}

export interface RunnerRecipeSummary {
  repository_id: Uuid;
  git_ref: string;
  git_commit_sha: string;
}

export interface RunnerContext {
  runtime_id: Uuid;
  runtime_group_id?: Uuid | null;
  experiment_id: Uuid | null;
  recipe_id: Uuid;
  recipe_repository_id?: Uuid | null;
  recipe_git_ref?: string | null;
  recipe_git_commit_sha?: string | null;
  recipe: RunnerRecipeSummary;
  arm_label: string | null;
  agent_name?: string | null;
  identity: RunnerIdentity;
  /** Echoed from the request when supplied. */
  caller?: RunCaller;
}

/**
 * Routing target for a runner — which DP endpoint / region the
 * session is bound to.
 */
export interface RunnerDeployment {
  /** DP base URL the runner should talk to. */
  endpoint: string;
  /** Short slug identifier for the deployment (e.g. `"gcp01"`). */
  slug: string;
  /** Region the deployment is hosted in (e.g. `"us-east-1"`). */
  region: string;
}

/**
 * CP `/run` response — the customer wire.
 *
 * The fields it omits are server-internal and are never returned to
 * customer callers.
 */
export interface RunnerSpec {
  session_id: string;
  /** Routing target — DP endpoint / slug / region. */
  deployment: RunnerDeployment;
  /**
   * RS256 `session_locator` JWT — the only credential the customer
   * holds. Sent as the `Authorization: Bearer ...` value on all DP
   * calls.
   */
  session_token: string;
  /** Session lifetime (ISO-8601). */
  expires_at: IsoDate;
  /** Resolved runtime / arm / recipe / identity / caller context. */
  runtime_context: RunnerContext;
}

export interface RunIdentityInput {
  user_id?: string;
  anonymous_id?: string;
  conversation_id?: string;
  /**
   * Tags to stamp on the `customer` member this identity mints, **if that
   * member is new**. Access-bearing, and bounded on both sides: attenuated to
   * the asserting agent member's own tags, and applied on create only — an
   * existing member's tags are never changed here. Tags use the same opaque,
   * exact-match validation as every other tag write.
   */
  tags?: string[];
  /**
   * Metadata to set on the `customer` member this identity names. Grants
   * nothing, so unlike `tags` it applies to an existing member too: the
   * keys are merged in, overwriting keys of the same name (including ones
   * an admin set) and keeping the rest. Absent or `{}` changes nothing; to
   * remove a key, use {@link MemberUpdateParams.metadata}. Same bounds as
   * {@link BusinessMemberCreateParams.metadata}. Not carried on the session's
   * claims.
   */
  metadata?: Record<string, string>;
}

// jscpd:ignore-start -- interface field lists mirroring the wire schema
/**
 * Optional segment.io-style observability payload on a {@link RunRequest}.
 *
 * Used by CP for telemetry / experiment-report slicing only —
 * **routing never reads `caller`**. Arm picks walk `identity.*` via
 * `hash_key_fields` only. Mixing the two would be a privacy +
 * stability footgun (e.g. routing on IP).
 *
 * Unknown fields ride along verbatim via the index signature.
 */
export interface RunCaller {
  ip?: string;
  user_agent?: string;
  locale?: string;
  library?: RunCallerLibrary;
  page?: RunCallerPage;
  /** Pass-through for app / device / os / campaign / network / etc. */
  [key: string]: unknown;
}

export interface RunCallerLibrary {
  name?: string;
  version?: string;
  [key: string]: unknown;
}

export interface RunCallerPage {
  path?: string;
  referrer?: string;
  search?: string;
  title?: string;
  url?: string;
  [key: string]: unknown;
}
// jscpd:ignore-end

/**
 * Input body for the CP `/v1/runtimes/{id}/run` and
 * `/v1/experiments/{id}/run` routes. The URL identifies the
 * runtime/experiment — do NOT include `deployment`, `runtime_id`, or
 * `experiment_id` in the body.
 */
export interface RunRequest {
  identity?: RunIdentityInput;
  /** Optional observability payload — see {@link RunCaller}. */
  caller?: RunCaller;
  /** Optional entrypoint agent. Omit to use the runtime default. */
  agent_name?: string;
  ttl_seconds?: number;
  /** Optional space-separated runner scopes, capped by the Control Plane. */
  scope?: string;
}
