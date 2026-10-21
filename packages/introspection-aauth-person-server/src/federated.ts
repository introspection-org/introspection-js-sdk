/**
 * The Person Server's side of a resource with its own Access Server: the
 * mission is weighed first, as for any resource, and an auth token request it
 * covers is redeemed at the AS. A spend lands only once the AS issues.
 */
import { type JWTPayload, decodeJwt } from "jose";
import { AAuthError, sameScale } from "@introspection-sdk/aauth-protocol";

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
  stillPending: (
    tenant: string,
    id: string,
    requirement?: string,
    retryAfter?: number,
  ) => Response;
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
   * `answeredAt`, when the approval was answered for this spend, puts it back
   * unanswered if the spend does not land, so a later poll can answer it.
   */
  async function spendApproved(
    tenant: string,
    approval: Approval,
    mission: Mission,
    withinBudget: boolean,
    answeredAt: number | undefined,
    budget: Budget | undefined = approval.budget,
  ): Promise<Mission | undefined> {
    if (!budget || !mission.budget || !sameScale(mission.budget, budget))
      return mission;
    const restore = async () => {
      if (answeredAt !== undefined)
        await store
          .transitionApproval(
            tenant,
            { status: approval.status, answered_at: answeredAt },
            approval,
          )
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
   * spend lands, or a wait while the AS decides or is busy. `stored` is
   * whether the approval is saved already; one that is not is saved only if it
   * must wait. Only the AS's own refusal ends a saved approval, answered then
   * as its denial: one that could not be reached is asked again on the
   * agent's next poll.
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
      if (
        stored &&
        err instanceof AAuthError &&
        err.status >= 400 &&
        err.status < 500 &&
        err.status !== 429
      )
        await store.transitionApproval(tenant, approval, {
          ...approval,
          status: "denied",
          answered_at: now(),
          decided_by: federation.access_server,
          decided_at: now(),
        });
      throw err;
    }
    if (answer.status !== "issued")
      return wait(tenant, approval, answer, stored);
    const answeredAt = stored ? now() : undefined;
    if (
      answeredAt !== undefined &&
      !(await store.transitionApproval(tenant, approval, {
        ...approval,
        answered_at: answeredAt,
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
      answeredAt,
      budget,
    );
    if (!spent) return reask(tenant, approval, answeredAt);
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

  /**
   * The AS is deciding: keep where it said to poll, and tell the agent to
   * wait. Or it was too busy to take the request: keep the request to send
   * again when the agent next polls.
   */
  async function wait(
    tenant: string,
    approval: Approval & { federation: Federation },
    answer: Exclude<AccessOutcome, { status: "issued" }>,
    stored: boolean,
  ): Promise<Response> {
    const { federation } = approval;
    const waiting =
      answer.status === "pending"
        ? {
            ...approval,
            federation: {
              ...federation,
              location: answer.location,
              requirement: answer.requirement,
            },
          }
        : approval;
    if (!stored) await store.insertApproval(tenant, waiting);
    else if (
      waiting.federation.location !== federation.location ||
      waiting.federation.requirement !== federation.requirement
    )
      await store.transitionApproval(tenant, approval, waiting);
    return ctx.stillPending(
      tenant,
      approval.id,
      waiting.federation.requirement,
      answer.retry_after,
    );
  }

  /** The budget moved since it was weighed: the approver decides, and the AS is asked again once they do. */
  async function reask(
    tenant: string,
    approval: Approval & { federation: Federation },
    answeredAt: number | undefined,
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
    if (answeredAt === undefined) await store.insertApproval(tenant, asking);
    else if (
      !(await store.transitionApproval(
        tenant,
        { status: approval.status, answered_at: answeredAt },
        asking,
      ))
    )
      return ctx.collected();
    await ctx.onApproval?.(asking);
    return ctx.stillPending(tenant, asking.id);
  }

  return { request, redeem, spendApproved };
}
