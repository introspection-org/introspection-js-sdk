/**
 * Flight Sector's rails for the demo page: the recipe's own Cedar policies,
 * evaluated in-process the way the platform's egress evaluates them before a
 * booking reaches the traveller's company. The request is mapped as
 * recipe/policies/routes.yaml maps `POST /v1/reserve`.
 */
import "server-only";

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  type CedarValueJson,
  isAuthorized,
  policySetTextToParts,
} from "@cedar-policy/cedar-wasm/nodejs";

import { BOOKING_ISSUER } from "../origins";

const POLICIES = path.join(process.cwd(), "recipe", "policies");

// What an Acme org owner would set on the member and the company in the
// platform: Sam is below the seniority Acme asks for business class.
const SAM_LEVEL = 4;
const ACME_BUSINESS_MIN_LEVEL = 5;

type Rule = { text: string; reason?: string };

function loadRules() {
  const parsed = policySetTextToParts(
    readFileSync(path.join(POLICIES, "travel.cedar"), "utf8"),
  );
  if (parsed.type !== "success") throw new Error("travel.cedar does not parse");
  const rules: Record<string, Rule> = {};
  for (const text of parsed.policies) {
    const id = /@id\("([^"]+)"\)/.exec(text)?.[1];
    if (id)
      rules[id] = { text, reason: /@reason\("([^"]+)"\)/.exec(text)?.[1] };
  }
  return {
    rules,
    schema: readFileSync(path.join(POLICIES, "schema.cedarschema"), "utf8"),
  };
}

let loaded: ReturnType<typeof loadRules> | undefined;

export type Verdict = {
  decision: "allow" | "deny";
  /** The forbid rules that matched, by id, with their reasons. */
  denied: { id: string; reason?: string }[];
  request: Record<string, unknown>;
};

function claims(quote: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(quote.split(".")[1], "base64url").toString());
}

/** Evaluate a `POST /v1/reserve` body as the egress would, for Sam. */
export function checkReserve(
  body: { offer_id: string; quote: string; purpose: string; payer: string },
  missionS256?: string,
): Verdict {
  loaded ??= loadRules();
  const quoted = claims(body.quote);
  const resource: Record<string, string | number> = {
    offer_id: body.offer_id,
    purpose: body.purpose,
    payer: body.payer,
  };
  for (const attr of ["kind", "cabin", "block_minutes", "total_cents"]) {
    if (quoted[attr] !== undefined)
      resource[attr] = quoted[attr] as string | number;
  }
  const context: Record<string, CedarValueJson> = missionS256
    ? { mission: { s256: missionS256, resources: [BOOKING_ISSUER] } }
    : {};
  const principal = { type: "Person", id: "sam" };
  const request = {
    principal: { ...principal, level: SAM_LEVEL, company: "acme" },
    action: "booking.reserve",
    resource: { type: "Booking", ...resource },
    context,
  };
  const answer = isAuthorized({
    principal,
    action: { type: "Action", id: "booking.reserve" },
    resource: { type: "Booking", id: body.offer_id },
    context,
    schema: loaded.schema,
    policies: {
      staticPolicies: Object.fromEntries(
        Object.entries(loaded.rules).map(([id, r]) => [id, r.text]),
      ),
    },
    entities: [
      {
        uid: { type: "Company", id: "acme" },
        attrs: { business_min_level: ACME_BUSINESS_MIN_LEVEL },
        parents: [],
      },
      {
        uid: principal,
        attrs: {
          level: SAM_LEVEL,
          company: { __entity: { type: "Company", id: "acme" } },
        },
        parents: [],
      },
      {
        uid: { type: "Booking", id: body.offer_id },
        attrs: resource,
        parents: [],
      },
    ],
  });
  if (answer.type !== "success") {
    throw new Error(
      `the rails could not evaluate: ${answer.errors.map((e) => e.message).join("; ")}`,
    );
  }
  const { decision, diagnostics } = answer.response;
  const denied =
    decision === "deny"
      ? diagnostics.reason
          .filter((id) => loaded!.rules[id]?.text.includes("forbid"))
          .map((id) => ({ id, reason: loaded!.rules[id]?.reason }))
      : [];
  return { decision, denied, request };
}
