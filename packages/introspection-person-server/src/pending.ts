/** The pending URL the agent polls: the approval's state, and its token once approved. */
import { type Context, sameScale } from "./context.js";
import { AAuthError, problem } from "./errors.js";
import type { Asker } from "./ask.js";
import type { Missions } from "./missions.js";
import type { Tokens } from "./person-token.js";
import type { Approval, Mission } from "./types.js";
import type { AgentVerifier } from "./verify-agent.js";

export function createPending(
  { store, now }: Context,
  {
    verifyAgent,
    liveMission,
    personToken,
    authToken,
    stillPending,
  }: Pick<AgentVerifier, "verifyAgent"> &
    Pick<Missions, "liveMission"> &
    Pick<Tokens, "personToken" | "authToken"> &
    Pick<Asker, "stillPending">,
) {
  // #region pending
  /** The agent polls with a signed GET; only the key that asked may read it. Results are minted now. */
  async function pendingState(
    tenant: string,
    request: Request,
    path: string,
    id: string,
  ): Promise<Response> {
    const agent = await verifyAgent(request, undefined, path);
    const approval = await store.approval(tenant, id);
    if (!approval || approval.agent.jkt !== agent.jkt)
      return problem(404, "not_found", "no such pending request");
    if (request.method === "DELETE") {
      if (approval.status === "pending")
        await store.transitionApproval(tenant, "pending", {
          ...approval,
          status: "denied",
          decided_by: "agent",
          decided_at: now(),
        });
      return new Response(null, { status: 204 });
    }
    if (approval.status === "denied")
      return problem(
        403,
        "denied",
        `${approval.approver.name ?? "The approver"} declined`,
      );
    if (approval.status === "pending")
      return now() >= approval.expires_at
        ? problem(408, "expired", "nobody answered in time")
        : stillPending(tenant, id);
    const collected = () =>
      problem(410, "collected", "this approval's token was already collected");
    if (approval.status === "collected") return collected();
    if (approval.kind === "completion") return Response.json({});
    // Nothing is issued under a mission that has ended, whatever was approved.
    const mission = await liveMission(tenant, agent, approval.mission_s256);
    if (approval.kind === "mission") {
      const tokens = await Promise.all(
        mission.resources.map(async (r) => [
          r,
          (await personToken(agent, mission.person, r, mission)).person_token,
        ]),
      );
      return Response.json({
        s256: mission.s256,
        mission: Buffer.from(mission.mission).toString("base64url"),
        person_tokens: Object.fromEntries(tokens),
      });
    }
    // Collected once: only the poll that collects it spends, so it spends and mints once.
    const collecting: Approval = { ...approval, status: "collected" };
    if (!(await store.transitionApproval(tenant, "approved", collecting)))
      return collected();
    let issuedUnder = mission;
    // A request in another unit than the mission's budget is approved without spending it.
    if (
      approval.budget &&
      mission.budget &&
      sameScale(mission.budget, approval.budget)
    ) {
      // Put back so a later poll can collect it once a spend lands.
      const restore = () =>
        store
          .transitionApproval(tenant, "collected", approval)
          .catch(() => false);
      let spent: Mission | undefined;
      try {
        spent = await store.spend(
          tenant,
          mission.s256,
          approval.budget.amount,
          false,
          now(),
        );
      } catch (error) {
        await restore();
        throw error;
      }
      if (!spent) {
        await restore();
        throw new AAuthError(
          403,
          "mission_terminated",
          "the mission has ended",
        );
      }
      issuedUnder = spent;
    }
    return Response.json(await authToken(agent, issuedUnder, approval.grant));
  }

  // #endregion

  return { pendingState };
}
