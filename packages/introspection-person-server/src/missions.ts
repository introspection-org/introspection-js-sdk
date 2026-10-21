/** Proposing a mission, updating or completing it, and checking one is live. */
import { type Context, s256, tenantOf, trim } from "./context.js";
import { AAuthError } from "./errors.js";
import type { Asker } from "./ask.js";
import type { Agent, Mission } from "./types.js";
import type { AgentVerifier } from "./verify-agent.js";

export type Missions = ReturnType<typeof createMissions>;

export function createMissions(
  { store, now, tenantFor }: Context,
  {
    readSigned,
    requester,
    ask,
  }: Pick<AgentVerifier, "readSigned" | "requester"> & Pick<Asker, "ask">,
) {
  // #region missions
  /** The live mission `s256` names, if it is this agent's; the same 404 otherwise. */
  async function liveMission(
    tenant: string,
    agent: Agent,
    hash: unknown,
  ): Promise<Mission> {
    const mission =
      typeof hash === "string" ? await store.mission(tenant, hash) : undefined;
    if (!mission || mission.agent_id !== agent.id)
      throw new AAuthError(404, "mission_not_found", "no such mission");
    // The agent identifier is the provider's; the person is the key's. Another
    // key under the same identifier, bound to someone else, is a stranger.
    if ((await store.binding(tenant, agent.jkt))?.id !== mission.person.id)
      throw new AAuthError(404, "mission_not_found", "no such mission");
    if (mission.completed_at !== undefined)
      throw new AAuthError(403, "mission_terminated", "mission completed");
    if (now() >= mission.expires_at)
      throw new AAuthError(403, "mission_terminated", "mission expired");
    return mission;
  }

  async function proposeMission(
    request: Request,
    path: string,
  ): Promise<Response> {
    const { agent, params } = await readSigned(request, path);
    const { tenant, person } = await requester(agent, params);
    const description = String(params.description ?? "");
    if (!description)
      throw new AAuthError(400, "invalid_request", "describe the mission");
    const resources = (Array.isArray(params.resources) ? params.resources : [])
      .map((r) => trim(String(r)))
      .filter((r) => r.startsWith("https://"));
    return ask(tenant, "mission", agent, person, description, {
      grant: { resources },
    });
  }

  async function missionAction(
    request: Request,
    path: string,
    hash: string,
  ): Promise<Response> {
    const { agent, params } = await readSigned(request, path);
    const tenant = tenantFor(tenantOf(params));
    const mission = await liveMission(tenant, agent, hash);
    if (params.action === "update") {
      const entry = String(params.description ?? "");
      if (
        !(await store.logMission(
          tenant,
          mission.s256,
          { at: now(), entry },
          now(),
        ))
      )
        throw new AAuthError(403, "mission_terminated", "mission ended");
      return Response.json({ s256: s256(entry) });
    }
    if (params.action === "completion")
      return ask(
        tenant,
        "completion",
        agent,
        mission.person,
        String(params.summary ?? "The agent says the mission is done"),
        {
          mission_s256: mission.s256,
        },
      );
    throw new AAuthError(
      400,
      "invalid_request",
      "action is update or completion",
    );
  }
  // #endregion

  return { liveMission, proposeMission, missionAction };
}
