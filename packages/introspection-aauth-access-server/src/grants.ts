/** What an auth token from this Access Server may grant: no more than was asked, and no more than may be spent. */
import {
  authGrant,
  type Budget,
  InvalidRequest,
  parseBudget,
  sameScale,
  ServerError,
} from "@introspection-sdk/aauth-protocol";
import type { JWTPayload } from "jose";

import type { AccessGrant } from "./types.js";

const words = (value: unknown) =>
  typeof value === "string" ? value.split(" ").filter(Boolean) : [];

/** `scope` as the policy granted it, which may be no broader than `asked`. */
export function narrowed(asked: unknown, scope: string | undefined) {
  if (scope === undefined) return typeof asked === "string" ? asked : undefined;
  const allowed = new Set(words(asked));
  if (words(scope).some((s) => !allowed.has(s)))
    throw new ServerError("the policy granted a scope that was not asked for");
  return scope;
}

/**
 * What this request may spend (draft-hardt-aauth-budgets #as-token-endpoint):
 * the budget the Person Server sent, which may not exceed the resource token's.
 */
export function bounded(sent: Budget | undefined, asked: Budget | undefined) {
  if (!sent || !asked) return sent;
  if (!sameScale(sent, asked))
    throw new InvalidRequest("the budget is not in the resource token's unit");
  return sent.amount <= asked.amount ? sent : asked;
}

/** The grant with the policy's lower budget, which may not exceed what may be spent. */
export function lowered(
  grant: AccessGrant,
  bound: Budget | undefined,
  lower: Budget | undefined,
): AccessGrant {
  if (!lower) return grant;
  let checked: Budget | undefined;
  try {
    checked = parseBudget(lower);
  } catch {
    checked = undefined;
  }
  if (
    !checked ||
    !bound ||
    !sameScale(checked, bound) ||
    checked.amount > bound.amount
  )
    throw new ServerError("the policy granted a budget above what was asked");
  return { ...grant, budget: checked };
}

/** The claims an auth token for `rt` carries besides its own, copied from the resource token; its scope is the policy's. */
export function grantFor(
  rt: JWTPayload,
  budget: Budget | undefined,
): AccessGrant {
  const copied = authGrant(rt, String(rt.iss), budget);
  delete copied.scope;
  return {
    ...copied,
    ps: String(rt.ps),
    ...(typeof rt.mission_s256 === "string"
      ? { mission_s256: rt.mission_s256 }
      : {}),
    ...(typeof rt.tenant === "string" ? { tenant: rt.tenant } : {}),
  };
}
