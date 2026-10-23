import type { CursorParams, IsoDate, Uuid } from "./common.js";

/**
 * How a Runtime acquires LLM provider credentials at session create.
 *
 * - `"managed"` — Introspection-managed keys (default; current behaviour).
 * - `"byok"`    — the project's Endpoint pool. Applicable LLM endpoints
 *                 are materialised into the session. Session create fails
 *                 with `byok_no_endpoints` if no applicable LLM endpoint
 *                 exists in the project.
 */
export type RuntimeLlmMode = "managed" | "byok";

/** One declared MCP server requirement resolved for one Runtime environment. */
export interface RuntimeMcpRequirement {
  slug?: string | null;
  mcp_server_id?: string;
  state: string;
  url_source?: string | null;
  endpoint_id?: Uuid | null;
  connector_id?: Uuid | null;
  connection_id?: Uuid | null;
  [key: string]: unknown;
}

export interface Runtime {
  id: Uuid;
  org_id: Uuid;
  project_id: Uuid;
  name: string;
  slug: string;
  description?: string | null;
  recipe_id: Uuid;
  is_active: boolean;
  llm_mode: RuntimeLlmMode;
  created_at: IsoDate;
  updated_at: IsoDate;
  /**
   * When set, the runtime has been withdrawn and will never resolve as the
   * active runtime for its environment; in-flight sticky runs keep using it.
   */
  yanked_at?: IsoDate | null;
  yanked_reason?: string | null;
  /**
   * Per-environment git ref each lane tracks
   * ({ environment: "main" | "pr/N" | <sha> }); a tracked lane auto-advances
   * to the newest build from that ref, an absent key is untracked.
   */
  environment_ref?: Record<string, string> | null;
  metadata?: Record<string, unknown> | null;
  /** The group this version belongs to; versions share a slug within it. */
  runtime_group_id?: Uuid;
  recipe_kind?: string;
  recipe_ref?: string;
  environments?: string[];
  /** The bake: `pending`, `queued`, `baking`, `ready` or `failed`. */
  image_build_status?: string;
  image_build_error_message?: string | null;
  image_build_metadata?: Record<string, unknown> | null;
  /** Every declared MCP server resolved for the environment, non-secret. */
  mcp_requirements?: RuntimeMcpRequirement[] | null;
}

export interface RuntimeListParams extends CursorParams {
  /** Project slug or id. */
  project?: string;
  /** Runtime slug or id. */
  runtime?: string;
  recipe_id?: Uuid;
  /**
   * Restrict to runtimes serving this environment (e.g. `"production"`).
   * An API key already selects its environment, so passing this alongside
   * one is a 400.
   */
  environment?: string;
}
