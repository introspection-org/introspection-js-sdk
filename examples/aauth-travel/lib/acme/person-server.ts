/**
 * Acme's own Person Server (AAuth -11, three-party), as a Business that brings
 * its own runs it: @introspection-sdk/aauth-person-server, configured with Acme's
 * people and Acme's way of asking. A trip is a mission the traveller's manager
 * approves once, budget and all; each booking whose price fits what is left is
 * authorized at once, and anything over goes back to the manager. Approvers
 * answer by a six-digit code Acme emails them.
 */
import "server-only";

import { createHash, randomInt, timingSafeEqual } from "node:crypto";

import {
  AAuthError,
  type Approval,
  createPersonServer,
  MemoryStore,
  type Mission,
  type Person,
  type PersonServer,
} from "@introspection-sdk/aauth-person-server";

import { record } from "../events";
import { agentProviders, PERSON_SERVER_URL } from "../origins";
import { people, type Person as Employee } from "../world";
import { sendApprovalEmail } from "./mail";

const TENANT = "acme";
const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const USD = { unit: "USD", decimals: 2 };

/** An approval Acme has asked someone about, with the code it emailed them. */
interface Asked {
  approval: Approval;
  reasons: string[];
  codeHash: string;
  expiresAt: number;
  attempts: number;
}

/** Keeps missions where the demo page can read them as they change. */
class AcmeStore extends MemoryStore {
  readonly trips = new Map<string, Mission>();
  override async insertMission(tenant: string, mission: Mission) {
    const inserted = await super.insertMission(tenant, mission);
    if (inserted) this.trips.set(mission.s256, mission);
    return inserted;
  }
}

const state = ((
  globalThis as unknown as { __acmePersonServer?: object }
).__acmePersonServer ??= {
  asked: new Map<string, Asked>(),
  store: new AcmeStore(),
}) as {
  asked: Map<string, Asked>;
  store: AcmeStore;
  server?: Promise<PersonServer>;
};

// #region directory
/** Acme speaks for its own employees only; each trip is their manager's to approve. */
const asPerson = (employee: Employee): Person => ({
  id: employee.external_user_id,
  name: employee.name,
  email: employee.email,
  tenant: TENANT,
});

function employee(loginHint: string) {
  return people.find(
    (p) =>
      p.company === TENANT &&
      (p.external_user_id === loginHint ||
        p.email === loginHint ||
        `user:${p.email}` === loginHint),
  );
}

function managerOf(person: Person) {
  const manager = people.find(
    (p) => p.external_user_id === employee(person.id)?.manager,
  );
  return manager && asPerson(manager);
}
// #endregion

const dollars = (cents: number) =>
  `$${Math.round(cents / 100).toLocaleString("en-US")}`;
const hash = (code: string) => createHash("sha256").update(code).digest();

/** The agent's suggested budget, if the description names one: "up to $3,000". Dana sets the real one. */
function suggestedCents(description: string): number | null {
  const match = /up to \$([\d,]+)/i.exec(description);
  return match ? Number(match[1]!.replace(/,/g, "")) * 100 : null;
}

function reasonsFor(approval: Approval): string[] {
  if (approval.kind === "mission") {
    const suggested = suggestedCents(approval.description);
    return [
      `A trip for ${approval.person.name}: you set its budget`,
      suggested === null
        ? "The agent suggested no budget"
        : `The agent suggested up to ${dollars(suggested)}`,
    ];
  }
  if (approval.kind === "completion")
    return ["The agent says the trip is booked"];
  const trip = approval.mission_s256
    ? state.store.trips.get(approval.mission_s256)
    : undefined;
  const left = trip?.budget ? trip.budget.amount - trip.spent : 0;
  return [
    `${dollars(approval.budget?.amount ?? 0)} is over the ${dollars(left)} left of this trip's budget`,
  ];
}

// #region ask
/** A person decides, by email with a six-digit code; the agent polls a pending URL meanwhile. */
async function ask(approval: Approval) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const reasons = reasonsFor(approval);
  state.asked.set(approval.id, {
    approval,
    reasons,
    codeHash: hash(code).toString("hex"),
    expiresAt: Date.now() + CODE_TTL_MS,
    attempts: 0,
  });
  await sendApprovalEmail({
    to: approval.approver.email ?? "",
    approverName: approval.approver.name ?? "",
    travellerName: approval.person.name ?? "",
    item: approval.summary ?? approval.description,
    reasons,
    link: `${PERSON_SERVER_URL}/approve/${approval.id}`,
    code,
  });
  record(
    "acme.approval_requested",
    `asked ${approval.approver.name} by email`,
    {
      pending: approval.id,
    },
  );
}
// #endregion

export function personServer(): Promise<PersonServer> {
  state.server ??= createPersonServer({
    issuer: PERSON_SERVER_URL,
    basePath: "/ps",
    name: "Acme Person Server",
    description:
      "Speaks for Acme's people. A manager approves each trip as a mission; bookings within it need no one.",
    trustedAgentProviders: (issuer) => agentProviders().includes(issuer),
    signingKey: process.env.ACME_PS_SIGNING_KEY,
    subjectSecret: process.env.ACME_PS_SUBJECT_SECRET,
    store: state.store,
    // Every Acme person is in the acme tenant, whether or not the agent names it.
    defaultTenant: TENANT,
    directory: {
      person: (hint) => {
        const found = employee(hint);
        return found && asPerson(found);
      },
      approver: (_, person) => managerOf(person),
    },
    onApproval: ask,
    onDecision: (approval) => {
      if (approval.status !== "approved" || !approval.mission_s256) return;
      const s = approval.mission_s256.slice(0, 8);
      if (approval.kind === "mission")
        record(
          "acme.mission_approved",
          `mission ${s}: ${dollars(approval.decided_budget?.amount ?? 0)}`,
          { s256: approval.mission_s256 },
        );
      if (approval.kind === "completion")
        record("acme.mission_completed", `mission ${s} completed`, {
          s256: approval.mission_s256,
        });
    },
    onIssued: (issued) => {
      if (issued.type !== "auth_token" || !issued.mission) return;
      const left = (issued.mission.budget?.amount ?? 0) - issued.mission.spent;
      record("acme.auth_token_issued", `booked; ${dollars(left)} left`, {
        s256: issued.mission.s256,
      });
    },
  });
  return state.server;
}

/** Serve a request at the path the agent addressed (Next rewrites Acme's host under /acme). */
export async function handle(request: Request, path: string) {
  return (await personServer()).handle(request, path);
}

// #region decide
/** The approver's answer from Acme's page, proven by the code Acme emailed. */
export async function decide(
  id: string,
  code: string,
  verdict: "approve" | "decline",
  budgetCents?: number,
) {
  const asked = state.asked.get(id);
  if (!asked) throw new AAuthError(404, "not_found", "no such request");
  if (asked.approval.status !== "pending")
    throw new AAuthError(
      409,
      "invalid_request",
      `already ${asked.approval.status}`,
    );
  if (asked.attempts >= MAX_ATTEMPTS || Date.now() > asked.expiresAt)
    throw new AAuthError(410, "invalid_code", "this code has expired");
  asked.attempts += 1;
  if (
    !/^\d{6}$/.test(code) ||
    !timingSafeEqual(hash(code), Buffer.from(asked.codeHash, "hex"))
  )
    throw new AAuthError(401, "invalid_code", "that code isn't right");
  const trip = asked.approval.kind === "mission";
  if (
    verdict === "approve" &&
    trip &&
    !(Number.isInteger(budgetCents) && budgetCents! > 0)
  )
    throw new AAuthError(400, "invalid_request", "set the trip's budget");
  asked.approval = await (
    await personServer()
  ).decide(asked.approval.tenant, id, {
    status: verdict === "approve" ? "approved" : "denied",
    ...(verdict === "approve" && trip
      ? { budget: { amount: budgetCents!, ...USD } }
      : {}),
    decided_by: asked.approval.approver.email ?? asked.approval.approver.id,
  });
  record(
    "acme.decided",
    `${asked.approval.approver.name} ${asked.approval.status}`,
    {
      pending: id,
      status: asked.approval.status,
    },
  );
  return { status: asked.approval.status };
}
// #endregion

/** The trips Acme has approved, oldest first. */
export function missions() {
  return [...state.store.trips.values()].map((m) => ({
    s256: m.s256,
    person: m.person.name ?? m.person.id,
    budget_cents: m.budget?.amount ?? 0,
    spent_cents: m.spent,
    terminated: m.completed_at !== undefined ? "completed" : undefined,
  }));
}

/** What the approval page shows. */
export function approvalSummary(id: string) {
  const asked = state.asked.get(id);
  if (!asked) return null;
  const { approval } = asked;
  const [user = "", domain = ""] = (approval.approver.email ?? "").split("@");
  return {
    status: approval.status,
    company: "Acme",
    traveller: approval.person.name ?? "",
    approver: approval.approver.name ?? "",
    sentTo: `${user.slice(0, 1)}•••@${domain}`,
    item: approval.summary ?? approval.description,
    reasons: asked.reasons,
    budget:
      approval.kind === "mission"
        ? { suggested_cents: suggestedCents(approval.description) }
        : undefined,
  };
}
