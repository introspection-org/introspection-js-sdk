import type { Approval, ApprovalStatus, Mission, Store } from "./types.js";

/** Everything in memory: for development, tests and single-process demos. */
export class MemoryStore implements Store {
  private readonly bindings = new Map<string, string>();
  private readonly missionsByHash = new Map<string, Mission>();
  private readonly approvalsById = new Map<string, Approval>();

  async binding(jkt: string) {
    return this.bindings.get(jkt);
  }

  async bind(jkt: string, personId: string) {
    const bound = this.bindings.get(jkt);
    if (bound) return bound;
    this.bindings.set(jkt, personId);
    return personId;
  }

  async mission(s256: string) {
    return this.missionsByHash.get(s256);
  }

  async putMission(mission: Mission) {
    this.missionsByHash.set(mission.s256, mission);
  }

  async spend(
    s256: string,
    amount: number,
    withinBudget: boolean,
    now: number,
  ) {
    const mission = this.missionsByHash.get(s256);
    if (
      !mission ||
      mission.completed_at !== undefined ||
      mission.expires_at <= now
    )
      return undefined;
    if (
      withinBudget &&
      (!mission.budget || mission.budget.amount - mission.spent < amount)
    )
      return undefined;
    mission.spent += amount;
    return mission;
  }

  async logMission(
    s256: string,
    entry: { at: number; entry: string },
    now: number,
  ) {
    const mission = this.missionsByHash.get(s256);
    if (
      !mission ||
      mission.completed_at !== undefined ||
      mission.expires_at <= now
    )
      return false;
    mission.log.push(entry);
    return true;
  }

  async endMission(s256: string, at: number) {
    const mission = this.missionsByHash.get(s256);
    if (mission) mission.completed_at ??= at;
    return mission;
  }

  async missions() {
    return [...this.missionsByHash.values()];
  }

  async approval(id: string) {
    return this.approvalsById.get(id);
  }

  async putApproval(approval: Approval) {
    this.approvalsById.set(approval.id, approval);
  }

  async transitionApproval(expected: ApprovalStatus, next: Approval) {
    if (this.approvalsById.get(next.id)?.status !== expected) return false;
    this.approvalsById.set(next.id, next);
    return true;
  }

  async approvals() {
    return [...this.approvalsById.values()];
  }
}
