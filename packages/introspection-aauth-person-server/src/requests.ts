/** What a Person Server reads from an agent's request before it verifies anything. */
import { createHash } from "node:crypto";

import {
  InvalidRequest,
  parseBudget,
  readJsonObject,
} from "@introspection-sdk/aauth-protocol";

import type { Decision } from "./types.js";

export const s256 = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("base64url");

/** Whether every member of a `Signature-Key` header uses the `jwt` scheme (draft-hardt-httpbis-signature-key). */
export const signsWithJwt = (header: string | null): boolean => {
  const schemes = [
    ...(header ?? "").matchAll(
      /(?:^|,)\s*[a-z*][a-z0-9_.*-]*=([a-z][a-z0-9_-]*)/g,
    ),
  ].map((m) => m[1]);
  return schemes.length > 0 && schemes.every((scheme) => scheme === "jwt");
};

/** The tenant a request body names; an empty one names none. */
export const tenantOf = (params: Record<string, unknown>) =>
  typeof params.tenant === "string" && params.tenant
    ? params.tenant
    : undefined;

/** A decision as the management route takes it. */
export async function readDecision(request: Request): Promise<Decision> {
  const params = readJsonObject(await request.text());
  const verdict = params.decision ?? params.status;
  if (!["approve", "approved", "deny", "denied"].includes(String(verdict)))
    throw new InvalidRequest("decision is approve or deny");
  return {
    status: String(verdict).startsWith("approve") ? "approved" : "denied",
    ...(params.budget !== undefined
      ? { budget: parseBudget(params.budget) }
      : {}),
    ...(typeof params.decided_by === "string"
      ? { decided_by: params.decided_by }
      : {}),
  };
}
