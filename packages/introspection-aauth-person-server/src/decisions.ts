/** The decisions a Person Server's operator makes on its approvals. */
import {
  type Budget,
  Expired,
  InvalidRequest,
  MissionTerminated,
  NotFound,
  parseBudget,
} from "@introspection-sdk/aauth-protocol";

import { s256 } from "./requests.js";
import type { Approval, Decision, Mission, Store } from "./types.js";

export class Decisions {
  constructor(
    private readonly store: Store,
    private readonly now: () => number,
    private readonly missionTtl: number,
    private readonly onDecision?: (approval: Approval) => void | Promise<void>,
  ) {}

  /**
   * Record a decision. Approving does what was asked: creates the mission or
   * completes it; an approved request is spent when its token is answered. A
   * decision is made once: a second, even a concurrent one, is a 409.
   * `tenant` is the one the agent asked under.
   */
  async decide(
    tenant: string,
    id: string,
    decision: Decision,
  ): Promise<Approval> {
    const approval = await this.store.approval(tenant, id);
    if (!approval) throw new NotFound("no such approval");
    if (approval.status !== "pending")
      throw new InvalidRequest("already decided", { status: 409 });
    if (this.now() >= approval.expires_at)
      throw new Expired("this approval has expired", { status: 410 });
    if (decision.budget && approval.kind !== "mission")
      throw new InvalidRequest("only a mission takes a budget");
    const budget = parseBudget(decision.budget);
    const decided: Approval = {
      ...approval,
      status: decision.status,
      ...(budget ? { decided_budget: budget } : {}),
      ...(decision.decided_by ? { decided_by: decision.decided_by } : {}),
      decided_at: this.now(),
    };
    let created: Mission | undefined;
    let existing: Mission | undefined;
    if (decision.status === "approved") {
      if (approval.kind === "mission") {
        created = this.newMission(tenant, approval, budget);
        decided.mission_s256 = created.s256;
      } else if (approval.mission_s256) {
        existing = await this.store.mission(tenant, approval.mission_s256);
        if (
          !existing ||
          existing.completed_at !== undefined ||
          this.now() >= existing.expires_at
        )
          throw new MissionTerminated("the mission has ended", {
            status: 409,
          });
      }
    }
    // The transition is the decision: what it does happens only once.
    // The mission goes in first, so a decision never points at a mission it did not create.
    if (created && !(await this.store.insertMission(tenant, created)))
      throw new InvalidRequest("already decided", { status: 409 });
    if (!(await this.store.transitionApproval(tenant, approval, decided))) {
      if (created)
        await this.store.endMission(tenant, created.s256, this.now());
      throw new InvalidRequest("already decided", { status: 409 });
    }
    if (existing && approval.kind === "completion")
      await this.store.endMission(tenant, existing.s256, this.now());
    await this.onDecision?.(decided);
    return decided;
  }

  /** The mission an approval asked for, approved now with `budget`. */
  private newMission(
    tenant: string,
    approval: Approval,
    budget: Budget | undefined,
  ): Mission {
    const resources = approval.resources ?? [];
    const expires_at = this.now() + this.missionTtl;
    // The approval's id makes each mission's hash its own.
    const bytes = JSON.stringify({
      approval: approval.id,
      agent: approval.agent.id,
      approved_at: new Date(this.now() * 1000).toISOString(),
      expires_at: new Date(expires_at * 1000).toISOString(),
      description: approval.description,
      approved_resources: resources,
      ...(budget ? { budget } : {}),
    });
    return {
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
  }
}
