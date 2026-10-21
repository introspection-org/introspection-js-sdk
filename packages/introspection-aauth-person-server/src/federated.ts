/**
 * The Person Server's side of a resource with its own Access Server: the
 * mission is weighed first, as for any resource, and an auth token request it
 * covers is redeemed at the AS. A spend lands only once the AS issues.
 */
import { type JWTPayload, decodeJwt } from "jose";
import { AAuthError } from "@introspection-sdk/aauth-protocol";

import {
  type AccessOutcome,
  type FederationContext,
  federate,
} from "./federation.js";
import type {
  Agent,
  Approval,
  ApprovalKind,
  Budget,
  Federation,
  Mission,
  Person,
  Store,
} from "./types.js";

type Asked = Partial<
  Pick<
    Approval,
    "mission_s256" | "resource" | "budget" | "grant" | "summary" | "federation"
  >
>;
type NewApproval = (
  tenant: string,
  kind: ApprovalKind,
  agent: Agent,
  person: Person,
  description: string,
  extra: Asked,
) => Promise<Approval>;

/** What a Person Server lends its federated requests. */
export interface FederatedContext {
  store: Store;
  now: () => number;
  federation: FederationContext;
  newApproval: NewApproval;
  /** Save a new approval, tell whoever decides, and answer the agent `202`. */
  ask: (...args: Parameters<NewApproval>) => Promise<Response>;
  stillPending: (tenant: string, id: string, requirement?: string) => Response;
  collected: () => Response;
  proposalSummary: (rt: JWTPayload) => Promise<string | undefined>;
  onApproval?: (approval: Approval) => void | Promise<void>;
  onIssued?: (issued: {
    type: "auth_token";
    agent: Agent;
    person: Person;
    resource: string;
    mission: Mission;
    budget?: Budget;
    access_server: string;
  }) => void | Promise<void>;
}

const sameScale = (a: Budget, b: Budget) =>
  a.unit === b.unit && a.decimals === b.decimals;

/** Whether a request fits what is left of its mission's budget. */
const fits = (mission: Mission, budget: Budget | undefined) =>
  !budget ||
  (!!mission.budget &&
    sameScale(mission.budget, budget) &&
    mission.spent + budget.amount <= mission.budget.amount);

export function federatedAccess(ctx: FederatedContext) {
  const { store, now } = ctx;

  /**
   * Spend an approval's budget on its mission, returning the mission it was
   * spent under; undefined when `withinBudget` and it no longer fits. A request
   * in another unit than the mission's budget is approved without spending it.
   * `collected` puts the collected approval back if the spend does not land, so
   * a later poll can collect it.
   */
  async function spendApproved(
    tenant: string,
    approval: Approval,
    mission: Mission,
    withinBudget: boolean,
    collected: boolean,
    budget: Budget | undefined = approval.budget,
  ): Promise<Mission | undefined> {
    if (!budget || !mission.budget || !sameScale(mission.budget, budget))
      return mission;
    const restore = async () => {
      if (collected)
        await store
          .transitionApproval(tenant, "collected", approval)
          .catch(() => false);
    };
    let spent: Mission | undefined;
    try {
      spent = await store.spend(
        tenant,
        mission.s256,
        budget.amount,
        withinBudget,
        now(),
      );
    } catch (error) {
      await restore();
      throw error;
    }
    if (spent || withinBudget) return spent;
    await restore();
    throw new AAuthError(403, "mission_terminated", "the mission has ended");
  }

  /** A request for a resource with its own Access Server; one over what is left goes to the approver first. */
  async function request(
    tenant: string,
    agent: Agent,
    mission: Mission,
    rt: JWTPayload,
    asked: Pick<Approval, "mission_s256" | "resource" | "budget" | "grant">,
    tokens: Omit<Federation, "within_budget" | "budget">,
  ): Promise<Response> {
    const description = String(rt.scope ?? "a request");
    const sent = asked.budget ? { budget: asked.budget } : {};
    if (!fits(mission, asked.budget))
      return ctx.ask(tenant, "auth_token", agent, mission.person, description, {
        ...asked,
        summary: await ctx.proposalSummary(rt),
        federation: { ...tokens, ...sent, within_budget: false },
      });
    const approval = await ctx.newApproval(
      tenant,
      "auth_token",
      agent,
      mission.person,
      description,
      asked,
    );
    return redeem(
      tenant,
      agent,
      mission,
      {
        ...approval,
        status: "approved",
        decided_at: now(),
        federation: { ...tokens, ...sent, within_budget: true },
      },
      false,
    );
  }

  /**
   * Redeem an approved request at its Access Server: its auth token, once the
   * spend lands, or a wait while the AS decides. `stored` is whether the
   * approval is saved already; one that is not is saved only if it must wait.
   * A refusal ends a saved approval as the AS's denial.
   */
  async function redeem(
    tenant: string,
    agent: Agent,
    mission: Mission,
    approval: Approval & { federation: Federation },
    stored: boolean,
  ): Promise<Response> {
    const { federation } = approval;
    let answer: AccessOutcome;
    try {
      answer = await federate(federation, agent.jkt, ctx.federation);
    } catch (err) {
      if (stored && err instanceof AAuthError)
        await store.transitionApproval(tenant, "approved", {
          ...approval,
          status: "denied",
          decided_by: federation.access_server,
          decided_at: now(),
        });
      throw err;
    }
    if (answer.status === "pending")
      return wait(tenant, approval, answer, stored);
    if (
      stored &&
      !(await store.transitionApproval(tenant, "approved", {
        ...approval,
        status: "collected",
      }))
    )
      return ctx.collected();
    // What the AS granted is what is spent; it may be less than was asked.
    const budget = answer.granted ?? approval.budget;
    const spent = await spendApproved(
      tenant,
      approval,
      mission,
      federation.within_budget,
      stored,
      budget,
    );
    if (!spent) return reask(tenant, approval, stored);
    await ctx.onIssued?.({
      type: "auth_token",
      agent,
      person: spent.person,
      resource: String(approval.resource),
      mission: spent,
      ...(budget ? { budget } : {}),
      access_server: federation.access_server,
    });
    return Response.json({
      auth_token: answer.auth_token,
      expires_in: answer.expires_in,
    });
  }

  /** The AS is deciding: keep where it said to poll, and tell the agent to wait. */
  async function wait(
    tenant: string,
    approval: Approval & { federation: Federation },
    answer: Extract<AccessOutcome, { status: "pending" }>,
    stored: boolean,
  ): Promise<Response> {
    const { federation } = approval;
    const waiting = {
      ...approval,
      federation: {
        ...federation,
        location: answer.location,
        requirement: answer.requirement,
      },
    };
    if (!stored) await store.putApproval(tenant, waiting);
    else if (
      answer.location !== federation.location ||
      answer.requirement !== federation.requirement
    )
      await store.transitionApproval(tenant, "approved", waiting);
    return ctx.stillPending(tenant, approval.id, answer.requirement);
  }

  /** The budget moved since it was weighed: the approver decides, and the AS is asked again once they do. */
  async function reask(
    tenant: string,
    approval: Approval & { federation: Federation },
    stored: boolean,
  ): Promise<Response> {
    const {
      access_server,
      resource_token,
      agent_token,
      presented_token,
      budget,
    } = approval.federation;
    const asking: Approval = {
      ...approval,
      status: "pending",
      summary:
        approval.summary ??
        (await ctx.proposalSummary(decodeJwt(resource_token))),
      federation: {
        access_server,
        resource_token,
        agent_token,
        presented_token,
        ...(budget ? { budget } : {}),
        within_budget: false,
      },
    };
    delete asking.decided_at;
    if (!stored) await store.putApproval(tenant, asking);
    else if (!(await store.transitionApproval(tenant, "collected", asking)))
      return ctx.collected();
    await ctx.onApproval?.(asking);
    return ctx.stillPending(tenant, asking.id);
  }

  return { request, redeem, spendApproved };
}
