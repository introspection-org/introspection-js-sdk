/** Reading a Person Server's token request, and the requirement a pending one is answered with. */
import { buildRequirementHeader } from "@aauth/resource";
import {
  InvalidRequest,
  parseBudget,
  readJsonObject,
  ServerError,
} from "@introspection-sdk/aauth-protocol";

import type { PendingAccess } from "./types.js";

/** The three tokens and the budget a token request carries. */
export function readTokens(body: string) {
  const { resource_token, agent_token, presented_token, budget } =
    readJsonObject(body);
  if (
    typeof resource_token !== "string" ||
    typeof agent_token !== "string" ||
    typeof presented_token !== "string"
  )
    throw new InvalidRequest(
      "resource_token, agent_token and presented_token are required",
    );
  return {
    resource_token,
    agent_token,
    presented_token,
    budget: parseBudget(budget),
  };
}

/** The `AAuth-Requirement` a pending request is answered with; a policy's bad interaction is a 500. */
export function requirementHeader(
  interaction: PendingAccess["interaction"],
): string {
  if (!interaction) return buildRequirementHeader({ requirement: "approval" });
  let https = false;
  try {
    https = new URL(interaction.url).protocol === "https:";
  } catch {
    // answered below
  }
  try {
    if (https)
      return buildRequirementHeader({
        requirement: "interaction",
        ...interaction,
      });
  } catch {
    // answered below
  }
  throw new ServerError(
    "the policy's interaction needs an https url and a code of printable ASCII",
  );
}
