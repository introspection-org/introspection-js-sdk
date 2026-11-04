import type {
  Approval,
  ApprovalDecision,
  ApprovalListParams,
  Mission,
  MissionListParams,
} from "@introspection-sdk/types";
import { Paginator, paginateGet } from "../pagination.js";
import type { ResourceHttpClient } from "./types.js";

const segment = (id: string): string => encodeURIComponent(id);

/**
 * The hosted Person Server's approvals (`/v1/aauth/approvals`), which the
 * customer's app decides. Reads need `approvals:read`, a decision
 * `approvals:write`.
 */
export class ApprovalsClient {
  constructor(private readonly http: ResourceHttpClient) {}

  /**
   * List approvals, newest first. `status` repeats; `pending` lists only
   * unexpired ones. `await` for the first page, or `for await` to stream
   * every approval across pages.
   */
  list(params?: ApprovalListParams): Paginator<Approval> {
    return paginateGet<Approval>(
      this.http,
      "/v1/aauth/approvals",
      params,
      params?.next,
    );
  }

  get(approvalId: string): Promise<Approval> {
    return this.http.request<Approval>({
      method: "GET",
      path: `/v1/aauth/approvals/${segment(approvalId)}`,
    });
  }

  /**
   * Record the approver's answer: `status`, a mission's `budget`, and who
   * decided. Approving does what the agent asked.
   */
  update(approvalId: string, body: ApprovalDecision): Promise<Approval> {
    return this.http.request<Approval>({
      method: "PATCH",
      path: `/v1/aauth/approvals/${segment(approvalId)}`,
      body,
    });
  }
}

/**
 * Missions the hosted Person Server approved, and what each has spent
 * (`/v1/aauth/missions`). Needs `approvals:read`.
 */
export class MissionsClient {
  constructor(private readonly http: ResourceHttpClient) {}

  /** List missions; `await` for the first page, or `for await` for all. */
  list(params?: MissionListParams): Paginator<Mission> {
    return paginateGet<Mission>(
      this.http,
      "/v1/aauth/missions",
      params,
      params?.next,
    );
  }

  get(missionId: string): Promise<Mission> {
    return this.http.request<Mission>({
      method: "GET",
      path: `/v1/aauth/missions/${segment(missionId)}`,
    });
  }
}

export { ApprovalsClient as ApprovalsApi, MissionsClient as MissionsApi };
