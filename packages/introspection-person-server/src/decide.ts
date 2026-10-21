/** Recording a decision on an approval, and doing what it approves. */
import { type Context, readBudget, s256 } from "./context.js";
import { AAuthError } from "./errors.js";
import type { Approval, Decision, Mission } from "./types.js";

export function createDecide({ options, store, now, missionTtl }: Context) {
  // #region decide
  /**
   * Record a decision. Approving does what was asked: creates the mission or
   * completes it; an approved request is spent when its token is collected. A decision is made once: a
   * second, even a concurrent one, is a 409. `tenant` is the one the agent
   * asked under.
   */
  async function decide(
    tenant: string,
    id: string,
    decision: Decision,
  ): Promise<Approval> {
    const approval = await store.approval(tenant, id);
    if (!approval) throw new AAuthError(404, "not_found", "no such approval");
    const already = () =>
      new AAuthError(409, "invalid_request", "already decided");
    if (approval.status !== "pending") throw already();
    if (now() >= approval.expires_at)
      throw new AAuthError(410, "expired", "this approval has expired");
    if (decision.budget && approval.kind !== "mission")
      throw new AAuthError(
        400,
        "invalid_request",
        "only a mission takes a budget",
      );
    const budget = readBudget(decision.budget);
    const decided: Approval = {
      ...approval,
      status: decision.status,
      ...(budget ? { decided_budget: budget } : {}),
      ...(decision.decided_by ? { decided_by: decision.decided_by } : {}),
      decided_at: now(),
    };
    let created: Mission | undefined;
    let existing: Mission | undefined;
    if (decision.status === "approved") {
      if (approval.kind === "mission") {
        const resources =
          (approval.grant.resources as string[] | undefined) ?? [];
        const expires_at = now() + missionTtl;
        // The approval's id makes each mission's hash its own.
        const bytes = JSON.stringify({
          approval: approval.id,
          agent: approval.agent.id,
          approved_at: new Date(now() * 1000).toISOString(),
          expires_at: new Date(expires_at * 1000).toISOString(),
          description: approval.description,
          approved_resources: resources,
          ...(budget ? { budget } : {}),
        });
        created = {
          tenant,
          s256: s256(bytes),
          mission: bytes,
          agent_id: approval.agent.id,
          person: approval.person,
          resources,
          ...(budget ? { budget } : {}),
          spent: 0,
          log: [],
          expires_at,
        };
        decided.mission_s256 = created.s256;
      } else if (approval.mission_s256) {
        existing = await store.mission(tenant, approval.mission_s256);
        if (
          !existing ||
          existing.completed_at !== undefined ||
          now() >= existing.expires_at
        )
          throw new AAuthError(
            409,
            "mission_terminated",
            "the mission has ended",
          );
      }
    }
    // The transition is the decision: what it does happens only once.
    // The mission goes in first, so a decision never points at a mission it did not create.
    if (created && !(await store.insertMission(tenant, created)))
      throw already();
    if (!(await store.transitionApproval(tenant, "pending", decided))) {
      if (created) await store.endMission(tenant, created.s256, now());
      throw already();
    }
    if (existing && approval.kind === "completion")
      await store.endMission(tenant, existing.s256, now());
    await options.onDecision?.(decided);
    return decided;
  }
  // #endregion

  return decide;
}
