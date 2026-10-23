import type {
  Approval,
  ApprovalState,
  Mission,
  Person,
  Store,
} from "./types.js";

/** One tenant's records of one kind, by their own identifiers. */
class Scoped<T> {
  private readonly byTenant = new Map<string, Map<string, T>>();

  get(tenant: string, id: string) {
    return this.byTenant.get(tenant)?.get(id);
  }

  set(tenant: string, id: string, value: T) {
    let records = this.byTenant.get(tenant);
    if (!records) this.byTenant.set(tenant, (records = new Map()));
    records.set(id, value);
  }

  all(tenant: string) {
    return [...(this.byTenant.get(tenant)?.values() ?? [])];
  }
}

/** Everything in memory: for development, tests and single-process demos. */
export class MemoryStore implements Store {
  private readonly bindings = new Scoped<Person>();
  private readonly missionsByHash = new Scoped<Mission>();
  private readonly approvalsById = new Scoped<Approval>();

  async binding(tenant: string, jkt: string) {
    return this.bindings.get(tenant, jkt);
  }

  async bind(tenant: string, jkt: string, person: Person) {
    const bound = this.bindings.get(tenant, jkt);
    if (bound) return bound;
    this.bindings.set(tenant, jkt, person);
    return person;
  }

  async mission(tenant: string, s256: string) {
    return this.missionsByHash.get(tenant, s256);
  }

  async insertMission(tenant: string, mission: Mission) {
    if (this.missionsByHash.get(tenant, mission.s256)) return false;
    this.missionsByHash.set(tenant, mission.s256, mission);
    return true;
  }

  async spend(
    tenant: string,
    s256: string,
    amount: number,
    withinBudget: boolean,
    now: number,
  ) {
    const mission = this.missionsByHash.get(tenant, s256);
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
    tenant: string,
    s256: string,
    entry: { at: number; entry: string },
    now: number,
  ) {
    const mission = this.missionsByHash.get(tenant, s256);
    if (
      !mission ||
      mission.completed_at !== undefined ||
      mission.expires_at <= now
    )
      return false;
    mission.log.push(entry);
    return true;
  }

  async endMission(tenant: string, s256: string, at: number) {
    const mission = this.missionsByHash.get(tenant, s256);
    if (mission) mission.completed_at ??= at;
    return mission;
  }

  async missions(tenant: string) {
    return this.missionsByHash.all(tenant);
  }

  async approval(tenant: string, id: string) {
    return this.approvalsById.get(tenant, id);
  }

  async insertApproval(tenant: string, approval: Approval) {
    this.approvalsById.set(tenant, approval.id, approval);
  }

  async transitionApproval(
    tenant: string,
    expected: ApprovalState,
    next: Approval,
  ) {
    const current = this.approvalsById.get(tenant, next.id);
    if (
      current?.status !== expected.status ||
      (current.collected ?? false) !== (expected.collected ?? false)
    )
      return false;
    this.approvalsById.set(tenant, next.id, next);
    return true;
  }

  async approvals(tenant: string) {
    return this.approvalsById.all(tenant);
  }
}
