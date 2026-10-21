/** Turning what needs a human into an approval, and the 202 the agent polls. */
import { randomUUID } from "node:crypto";

import type { Context } from "./context.js";
import type { Agent, Approval, ApprovalKind, Person } from "./types.js";

export type Asker = ReturnType<typeof createAsker>;

export function createAsker({
  options,
  store,
  now,
  approvalTtl,
  retryAfter,
  endpoints,
}: Context) {
  // #region ask
  async function ask(
    tenant: string,
    kind: ApprovalKind,
    agent: Agent,
    person: Person,
    description: string,
    extra: Partial<
      Pick<
        Approval,
        "mission_s256" | "resource" | "budget" | "grant" | "summary"
      >
    >,
  ): Promise<Response> {
    const approver =
      (kind === "completion"
        ? undefined
        : await options.directory.approver?.(kind, person)) ?? person;
    const created = now();
    const approval: Approval = {
      tenant,
      id: randomUUID(),
      kind,
      status: "pending",
      agent,
      person,
      approver,
      description,
      grant: {},
      ...extra,
      created_at: created,
      expires_at: created + approvalTtl,
    };
    await store.putApproval(tenant, approval);
    await options.onApproval?.(approval);
    return stillPending(tenant, approval.id);
  }

  const stillPending = (tenant: string, id: string) =>
    Response.json(
      { status: "pending" },
      {
        status: 202,
        headers: {
          Location: endpoints.pending(tenant, id),
          "Retry-After": String(retryAfter),
          "Cache-Control": "no-store",
          "AAuth-Requirement": "requirement=approval",
        },
      },
    );

  // #endregion

  return { ask, stillPending };
}
