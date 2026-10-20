/**
 * Acme on Introspection's hosted Person Server. The platform runs the
 * protocol, the missions and their budgets; Acme keeps the human side. This
 * module is Acme's approval app: it lists what is waiting with Acme's project
 * key, emails the approver a six-digit code exactly as Acme's own Person Server
 * does, and records the answer on the platform.
 */
import "server-only";

import { createHash, randomInt, timingSafeEqual } from "node:crypto";

import { serviceAccountToken } from "@introspection-sdk/introspection-node";

import { AAuthError } from "../aauth";
import { record } from "../events";
import { ACME_APPROVAL_URL } from "../origins";
import { people, type Person } from "../world";
import { sendApprovalEmail } from "./mail";

// Read on each use: `pnpm dev` writes these to .env.local after the app starts.
const apiBase = () =>
  (process.env.ACME_INTROSPECTION_URL ?? "http://localhost:8002").replace(
    /\/+$/,
    "",
  );
/** Acme's own application, which may only read and answer approvals. */
const account = () => {
  const clientId = process.env.ACME_CLIENT_ID;
  const clientSecret = process.env.ACME_CLIENT_SECRET;
  const project = process.env.ACME_PROJECT;
  return clientId && clientSecret && project
    ? {
        clientId,
        clientSecret,
        project,
        baseApiUrl: process.env.INTROSPECTION_BASE_API_URL,
      }
    : null;
};
const minted = ((
  globalThis as unknown as { __acmeToken?: { token: string; until: number } }
).__acmeToken ??= { token: "", until: 0 });

/** A token for Acme's application, minted again a minute before it expires. */
async function token(): Promise<string> {
  const credentials = account();
  if (!credentials) return "";
  if (minted.token && Date.now() < minted.until) return minted.token;
  const { access_token, expires_in } = await serviceAccountToken(credentials);
  minted.token = access_token;
  minted.until = Date.now() + Math.max(expires_in - 60, 30) * 1000;
  return minted.token;
}
const orgId = () => process.env.ACME_ORG_ID ?? "";
const POLL_MS = 2_000;
const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const USD = { unit: "USD", decimals: 2 };

interface Budget {
  amount: number;
  unit: string;
  decimals: number;
}

/** A platform approval, as `GET /v1/approvals` returns it. */
interface Approval {
  id: string;
  kind: "mission" | "auth_token" | "completion";
  status: "pending" | "approved" | "denied";
  member_id: string;
  mission_id: string | null;
  description: string;
  resource: string | null;
  budget: Budget | null;
  summary: string | null;
  expires_at: string;
}

interface Mission {
  id: string;
  s256: string;
  member_id: string;
  budget: Budget | null;
  spent: number;
  completed_at: string | null;
}

interface Asked {
  approval: Approval;
  person: Person;
  approver: Person;
  reasons: string[];
  codeHash: string;
  expiresAt: number;
  attempts: number;
}

const state = ((
  globalThis as unknown as { __acmeHosted?: object }
).__acmeHosted ??= {
  asked: new Map<string, Asked>(),
  missions: [] as Mission[],
  started: false,
}) as { asked: Map<string, Asked>; missions: Mission[]; started: boolean };

async function api<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await token()}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok)
    throw new AAuthError(
      response.status,
      "platform_error",
      `${method} ${path}: ${await response.text()}`,
    );
  return (await response.json()) as T;
}

/** The customer member id the platform derives for an identity: uuid5(org, key). */
function memberId(key: string): string {
  const namespace = Buffer.from(orgId().replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(namespace).update(key).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The person a member id names: the platform knows Sam as `user:{email}`.
 * Anyone else in the project, such as you chatting from the Introspection app,
 * travels for Acme too, with Dana as their manager.
 */
const personOf = (member: string): Person =>
  people.find(
    (p) => p.company === "acme" && memberId(`user:${p.email}`) === member,
  ) ?? {
    external_user_id: `member:${member}`,
    company: "acme",
    name: "You, from the Introspection app",
    email: "you@acme.example",
    manager: people.find((p) => p.name === "Dana Park")!.external_user_id,
  };

/** Who decided, as the platform names a member: the identity it knows them by, or their member id. */
const approverOf = (person: Person) =>
  person.external_user_id.startsWith("member:")
    ? { member_id: person.external_user_id.slice("member:".length) }
    : { identity: { user_id: person.email } };

const managerOf = (person: Person) =>
  people.find((p) => p.external_user_id === person.manager);

const dollars = (cents: number) =>
  `$${Math.round(cents / 100).toLocaleString("en-US")}`;
const hash = (code: string) => createHash("sha256").update(code).digest();

/** The agent's suggested budget, if the description names one: "up to $3,000". */
function suggestedCents(description: string): number | null {
  const match = /up to \$([\d,]+)/i.exec(description);
  return match ? Number(match[1].replace(/,/g, "")) * 100 : null;
}

function reasonsFor(approval: Approval, person: Person): string[] {
  if (approval.kind === "mission") {
    const suggested = suggestedCents(approval.description);
    return [
      `A trip for ${person.name}: you set its budget`,
      suggested === null
        ? "The agent suggested no budget"
        : `The agent suggested up to ${dollars(suggested)}`,
    ];
  }
  if (approval.kind === "completion")
    return ["The agent says the trip is booked"];
  const mission = state.missions.find((m) => m.id === approval.mission_id);
  const left = mission?.budget ? mission.budget.amount - mission.spent : null;
  const asked = approval.budget
    ? dollars(approval.budget.amount)
    : "This booking";
  return [
    left === null
      ? `${asked} needs your approval`
      : `${asked} is over the ${dollars(left)} left of this trip's budget`,
  ];
}

/** Email the approver for each approval Acme has not asked about yet. */
async function sync(): Promise<void> {
  const [pending, missions] = await Promise.all([
    api<{ records: Approval[] }>(
      "GET",
      "/v1/approvals?status=pending&limit=50",
    ),
    api<{ records: Mission[] }>("GET", "/v1/missions?limit=50"),
  ]);
  state.missions = missions.records;
  for (const approval of pending.records) {
    const known = state.asked.get(approval.id);
    if (known) {
      known.approval = approval;
      continue;
    }
    const person = personOf(approval.member_id);
    const approver =
      person && (approval.kind === "completion" ? person : managerOf(person));
    if (!person || !approver) continue;
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const reasons = reasonsFor(approval, person);
    state.asked.set(approval.id, {
      approval,
      person,
      approver,
      reasons,
      codeHash: hash(code).toString("hex"),
      expiresAt: Date.now() + CODE_TTL_MS,
      attempts: 0,
    });
    await sendApprovalEmail({
      to: approver.email,
      approverName: approver.name,
      travellerName: person.name,
      item: approval.summary ?? approval.description,
      reasons,
      link: `${ACME_APPROVAL_URL}/approve/${approval.id}`,
      code,
    });
    record("acme.approval_requested", `asked ${approver.name} by email`, {
      pending: approval.id,
    });
  }
}

/** Start following the platform's approvals, once per process. */
export function start(): void {
  if (state.started) return;
  state.started = true;
  // `pnpm dev` writes Acme's credentials after the app boots, so until they
  // appear each tick waits for them rather than giving up.
  const tick = () =>
    (account() ? sync() : Promise.resolve())
      .catch((err: Error) =>
        console.error(`[acme] approvals sync: ${err.message}`),
      )
      .finally(() => setTimeout(tick, POLL_MS));
  void tick();
}

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
  if (asked.attempts >= MAX_ATTEMPTS || Date.now() > asked.expiresAt) {
    // Forgetting it has the next sync email the approver a fresh code.
    state.asked.delete(id);
    throw new AAuthError(
      410,
      "invalid_code",
      "this code has expired; a new one is on its way",
    );
  }
  asked.attempts += 1;
  if (
    !/^\d{6}$/.test(code) ||
    !timingSafeEqual(hash(code), Buffer.from(asked.codeHash, "hex"))
  )
    throw new AAuthError(401, "invalid_code", "that code isn't right");
  const mission = asked.approval.kind === "mission";
  if (
    verdict === "approve" &&
    mission &&
    !(Number.isInteger(budgetCents) && budgetCents! > 0)
  )
    throw new AAuthError(400, "invalid_request", "set the trip's budget");
  asked.approval = await api<Approval>("PATCH", `/v1/approvals/${id}`, {
    status: verdict === "approve" ? "approved" : "denied",
    ...(verdict === "approve" && mission
      ? { budget: { amount: budgetCents, ...USD } }
      : {}),
    decided_by: approverOf(asked.approver),
  });
  record("acme.decided", `${asked.approver.name} ${asked.approval.status}`, {
    pending: id,
    status: asked.approval.status,
  });
  return { status: asked.approval.status };
}

/** What the approval page shows. */
export function approvalSummary(id: string) {
  const asked = state.asked.get(id);
  if (!asked) return null;
  const [user = "", domain = ""] = asked.approver.email.split("@");
  return {
    status: asked.approval.status,
    company: "Acme",
    traveller: asked.person.name,
    approver: asked.approver.name,
    sentTo: `${user.slice(0, 1)}•••@${domain}`,
    item: asked.approval.summary ?? asked.approval.description,
    reasons: asked.reasons,
    budget:
      asked.approval.kind === "mission"
        ? { suggested_cents: suggestedCents(asked.approval.description) }
        : undefined,
  };
}

/** The trips the hosted Person Server has approved, oldest first. */
export function missions() {
  return [...state.missions].reverse().map((m) => ({
    s256: m.s256,
    person: personOf(m.member_id)?.name ?? "someone",
    budget_cents: m.budget?.amount ?? 0,
    spent_cents: m.spent,
    terminated: m.completed_at ? "completed" : undefined,
  }));
}
