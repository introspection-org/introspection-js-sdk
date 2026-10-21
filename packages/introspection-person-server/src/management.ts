/** The management routes (`/consent`, `/missions`), behind the admin token. */
import { type Context, readBody, readBudget } from "./context.js";
import { AAuthError, problem } from "./errors.js";
import type { Approval, Decision, Mission } from "./types.js";

export function createManagement(
  { options, store, now, tenantFor }: Context,
  decide: (tenant: string, id: string, decision: Decision) => Promise<Approval>,
) {
  // #region management
  function admitted(request: Request) {
    const header = request.headers.get("authorization") ?? "";
    if (!options.adminToken || header !== `Bearer ${options.adminToken}`)
      throw new AAuthError(
        401,
        "unauthorized",
        "the management routes need the admin token",
      );
  }

  async function terminate(tenant: string, hash: string): Promise<Mission> {
    const ended = await store.endMission(tenant, hash, now());
    if (!ended)
      throw new AAuthError(404, "mission_not_found", "no such mission");
    return ended;
  }

  async function manage(
    request: Request,
    path: string,
  ): Promise<Response | undefined> {
    const consent = /^\/consent(?:\/([^/]+)\/decision)?$/.exec(path);
    const mission = /^\/missions(?:\/([^/]+))?$/.exec(path);
    if (!consent && !mission) return undefined;
    admitted(request);
    const query = new URL(request.url).searchParams;
    const tenant = tenantFor(query.get("tenant") || undefined);
    if (consent && request.method === "GET" && !consent[1]) {
      const status = query.get("status");
      return Response.json(
        (await store.approvals(tenant)).filter(
          (a) => !status || a.status === status,
        ),
      );
    }
    if (consent?.[1] && request.method === "POST") {
      const params = readBody(await request.text());
      const verdict = params.decision ?? params.status;
      if (!["approve", "approved", "deny", "denied"].includes(String(verdict)))
        throw new AAuthError(
          400,
          "invalid_request",
          "decision is approve or deny",
        );
      return Response.json(
        await decide(tenant, consent[1], {
          status: String(verdict).startsWith("approve") ? "approved" : "denied",
          ...(params.budget !== undefined
            ? { budget: readBudget(params.budget) }
            : {}),
          ...(typeof params.decided_by === "string"
            ? { decided_by: params.decided_by }
            : {}),
        }),
      );
    }
    if (mission && request.method === "GET") {
      if (!mission[1]) return Response.json(await store.missions(tenant));
      const found = await store.mission(tenant, mission[1]);
      return Response.json(found ?? null, { status: found ? 200 : 404 });
    }
    if (mission?.[1] && request.method === "PATCH")
      return Response.json(await terminate(tenant, mission[1]));
    return problem(405, "method_not_allowed");
  }
  // #endregion

  return { terminate, manage };
}
