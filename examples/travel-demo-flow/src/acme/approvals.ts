/**
 * Acme's side of an approval, whichever Person Server speaks for its people:
 * Acme's own (`PERSON_SERVER=acme`), or Introspection's hosted one with Acme's
 * approval app deciding through the platform (`PERSON_SERVER=hosted`).
 */
import "server-only";

import { PERSON_SERVER_MODE } from "../origins";
import * as hosted from "./hosted";
import * as own from "./person-server";

const acme = PERSON_SERVER_MODE === "hosted" ? hosted : own;

export const approvalSummary = (id: string) => acme.approvalSummary(id);
export const missions = () => acme.missions();
export const decide = (
  id: string,
  code: string,
  verdict: "approve" | "decline",
  budgetCents?: number,
) => acme.decide(id, code, verdict, budgetCents);
