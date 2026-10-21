import type { CursorParams, Environment, IsoDate, Uuid } from "./common.js";

export type ExperimentStatus = "draft" | "running" | "ended" | "cancelled";

export type ExperimentGoalDirection = "maximize" | "minimize";

/** Canary bound over one goal component's rate. */
export interface ExperimentGoalGuard {
  min?: number | null;
  max?: number | null;
}

/**
 * Judge-backed reward component. `judge_id` comes from `GET /v1/judges` —
 * judges cannot be created via the API; author a `judges/*.yaml` in the
 * recipe repository and it syncs when a runtime versions that commit.
 */
export interface JudgeGoalComponent {
  source: "judge";
  judge_id: Uuid;
  judge_definition_hash?: string | null;
  weight?: number;
  guard?: ExperimentGoalGuard | null;
}

/** Reserved shape for future telemetry-backed reward components. */
export interface TelemetryGoalComponent {
  source: "telemetry";
  column?: string | null;
  aggregation?: string | null;
  weight?: number;
  guard?: ExperimentGoalGuard | null;
}

export type ExperimentGoalComponent =
  JudgeGoalComponent | TelemetryGoalComponent;

/**
 * Composite objective the bandit optimizes. Create requires at least one
 * `source: "judge"` component with positive weight — the v1 scorer only
 * implements judge-backed reward.
 */
export interface ExperimentGoal {
  kind: "composite";
  direction?: ExperimentGoalDirection;
  components: ExperimentGoalComponent[];
}

/** One arm — a runtime version in the experiment's group + display label. */
export interface ExperimentArm {
  runtime_id: Uuid;
  arm_label: string;
  agent_overrides?: Record<string, string> | null;
}

export interface Experiment {
  id: Uuid;
  org_id: Uuid;
  project_id: Uuid;
  name: string;
  runtime_group_id?: Uuid | null;
  environment?: string | null;
  status: ExperimentStatus;
  routing_strategy?: string | null;
  arms: ExperimentArm[];
  goal_json?: ExperimentGoal | null;
  scoring_interval_seconds?: number | null;
  hash_key_fields?: string[] | null;
  sample_rate?: number | null;
  description?: string | null;
  posterior_json?: Record<string, unknown> | null;
  weights_json?: Record<string, number> | null;
  started_at?: IsoDate | null;
  ended_at?: IsoDate | null;
  halted_at?: IsoDate | null;
  halted_reason?: string | null;
  created_at: IsoDate;
  updated_at: IsoDate;
}

export interface ExperimentListParams extends CursorParams {
  project?: string;
  /** Runtime slug or group id. */
  runtime?: string;
  /** Lane the experiment runs in. */
  environment?: Environment;
  status?: ExperimentStatus;
}

/** What kind of principal a member row is. */
