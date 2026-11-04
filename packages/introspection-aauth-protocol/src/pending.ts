/** Deferred responses (#deferred-responses): the `202` an agent or Person Server polls, and reading one. */
import {
  UnsupportedRequirementError,
  parseRequirementHeader,
} from "@aauth/resource";

export const APPROVAL_REQUIREMENT = "requirement=approval";

/** `202`: poll `location` until it is decided. */
export const pendingResponse = (
  location: string,
  retryAfter: number,
  requirement = APPROVAL_REQUIREMENT,
): Response =>
  Response.json(
    { status: "pending" },
    {
      status: 202,
      headers: {
        Location: location,
        "Retry-After": String(retryAfter),
        "Cache-Control": "no-store",
        "AAuth-Requirement": requirement,
      },
    },
  );

/** The requirement an `AAuth-Requirement` header names, or undefined when it is malformed. */
export function requirementName(header: string): string | undefined {
  try {
    return parseRequirementHeader(header).requirement;
  } catch (err) {
    return err instanceof UnsupportedRequirementError ? err.value : undefined;
  }
}

/** `Retry-After` in seconds, when it is a number of them. */
export function retryAfter(headers: Headers): number | undefined {
  const seconds = Number(headers.get("retry-after") ?? "");
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}
