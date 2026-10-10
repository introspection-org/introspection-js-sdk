/**
 * The demo page's run: Flight Sector's agent, scripted, doing over AAuth what
 * the platform's egress does for the recipe. Sam's prompt sets the plan; the
 * agent makes real calls to Acme and the booking provider, every booking passes
 * the recipe's Cedar rails first, and where Acme needs a person it waits until
 * that person decides on the page, as they would from Acme's email.
 */
import "server-only";

import { createAAuthFetch, pollDeferred } from "@aauth/agent";

import { clearInbox, inbox } from "../acme/mail";
import { approvalSummary } from "../acme/person-server";
import { since } from "../events";
import { BOOKING_ISSUER, PERSON_SERVER_URL } from "../origins";
import { people } from "../world";
import { type DemoAgent, newAgent } from "./agent-provider";
import { checkReserve } from "./rails";
import {
  as,
  exchanges,
  installRecorder,
  note,
  startRecording,
  stopRecording,
} from "./wire";

const SAM = people.find((p) => p.name.startsWith("Sam"))!.external_user_id;

export const SCENARIOS = [
  {
    id: "approved",
    title: "Over budget, Dana approves",
    prompt:
      "Book me economy to Sydney for 19 to 23 October, and the QT Sydney. Up to $3,000.",
    hint: "Approve the trip at $3,000. The flight books on its own; approve the QT when Dana is asked.",
  },
  {
    id: "first",
    title: "First class: the rails refuse",
    prompt:
      "Fly me first class to Sydney for 19 to 23 October, with the Harbour Rocks. Up to $20,000.",
    hint: "Approve the trip. Flight Sector's Cedar rails refuse first class before Acme is ever asked.",
  },
  {
    id: "personal",
    title: "Personal trip on the company",
    prompt:
      "A personal weekend in Sydney, 19 to 23 October, economy and the Harbour Rocks, on the company account. Up to $3,000.",
    hint: "Approve the trip. The rails refuse each booking: personal travel is paid by the traveller.",
  },
  {
    id: "declined",
    title: "Over budget, Dana declines",
    prompt:
      "Economy to Sydney for 19 to 23 October and the QT Sydney. Up to $2,000.",
    hint: "Approve the trip at $2,000. The flight fits; decline the QT when Dana is asked.",
  },
] as const;

type Plan = {
  prompt: string;
  cabin: "economy" | "premium_economy" | "business" | "first";
  hotel?: "qt-sydney" | "harbour-rocks";
  purpose: "business" | "personal";
  payer: "company" | "traveller";
};

/** Sam's request, read the way the recipe's agent would read it, minus the model. */
function planOf(prompt: string): Plan {
  const p = prompt.toLowerCase();
  const cabin = /\bfirst\b/.test(p)
    ? "first"
    : /business class|\bbusiness\b(?! trip)/.test(p)
      ? "business"
      : /premium/.test(p)
        ? "premium_economy"
        : "economy";
  const hotel = /no hotel|without a hotel|flights? only/.test(p)
    ? undefined
    : /\bqt\b/.test(p)
      ? "qt-sydney"
      : /harbour|hotel/.test(p)
        ? "harbour-rocks"
        : undefined;
  const purpose = /personal|holiday|vacation|weekend away/.test(p)
    ? "personal"
    : "business";
  const payer = /my own card|i'll pay|myself|my card/.test(p)
    ? "traveller"
    : "company";
  return { prompt, cabin, hotel, purpose, payer };
}

type Chat = { from: "Sam" | "Agent"; text: string };
type Run = {
  plan?: Plan;
  busy: boolean;
  chat: Chat[];
  error?: string;
  agent?: DemoAgent;
  mission?: { s256: string; budget_cents: number };
  booked: string[];
  eventsFrom: number;
  inboxFrom: number;
  decided: number[];
  /** The chat line each email arrived under. */
  emailTurns: Record<number, number>;
};

const fresh = (): Run => ({
  busy: false,
  chat: [],
  booked: [],
  eventsFrom: Number.MAX_SAFE_INTEGER,
  inboxFrom: 0,
  decided: [],
  emailTurns: {},
});
const store = globalThis as unknown as { __demoRun?: Run };
const run = () => (store.__demoRun ??= fresh());

const CABINS: Record<string, string> = {
  economy: "economy",
  premium_economy: "premium economy",
  business: "business class",
  first: "first class",
};

const dollars = (cents: number) =>
  `$${Math.round(cents / 100).toLocaleString("en-US")}`;
const say = (from: Chat["from"], text: string) =>
  run().chat.push({ from, text });

export function snapshot() {
  const r = run();
  const sent = inbox();
  return {
    prompt: r.plan?.prompt,
    busy: r.busy,
    chat: r.chat,
    error: r.error,
    mission: r.mission,
    exchanges: exchanges(),
    events: r.eventsFrom === Number.MAX_SAFE_INTEGER ? [] : since(r.eventsFrom),
    inbox: sent.slice(r.inboxFrom).map((email, i) => {
      const budget = approvalSummary(email.link.split("/").pop() ?? "")?.budget;
      (r.emailTurns ??= {})[r.inboxFrom + i] ??= r.chat.length;
      return {
        index: r.inboxFrom + i,
        turn: r.emailTurns[r.inboxFrom + i],
        to: email.approverName,
        item: email.item,
        reasons: email.reasons,
        code: email.code,
        budget: budget
          ? {
              suggested:
                budget.suggested_cents === null
                  ? null
                  : budget.suggested_cents / 100,
            }
          : null,
        decided: r.decided.includes(r.inboxFrom + i),
      };
    }),
  };
}

export function reset() {
  store.__demoRun = fresh();
  stopRecording();
  clearInbox();
}

async function offer(
  kind: "flight" | "hotel",
  pick: (o: Record<string, unknown>) => boolean,
) {
  const body =
    kind === "hotel"
      ? { kind, city: "SYD", check_in: "2026-10-19", check_out: "2026-10-23" }
      : { kind, from: "SFO", to: "SYD", date: "2026-10-18" };
  const response = await fetch(`${BOOKING_ISSUER}/v1/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const { offers } = (await response.json()) as {
    offers: Record<string, unknown>[];
  };
  return offers.find(pick) ?? offers[0];
}

type Reserved = {
  status: number;
  body: Record<string, unknown>;
  refused?: string;
};

/** Reserve through the rails, then over AAuth: the order the platform's egress runs them in. */
async function reserve(
  r: Run,
  chosen: Record<string, unknown>,
  missionS256?: string,
): Promise<Reserved> {
  const body = {
    offer_id: String(chosen.offer_id),
    quote: String(chosen.quote),
    purpose: r.plan!.purpose,
    payer: r.plan!.payer,
  };
  const verdict = checkReserve(body, missionS256);
  const reasons = verdict.denied.map(
    (d) => `${d.id}: ${d.reason ?? "forbidden"}`,
  );
  note({
    from: "Agent",
    to: "Rails",
    label:
      verdict.decision === "allow"
        ? "Cedar: booking.reserve → allow"
        : `Cedar: deny (${verdict.denied.map((d) => d.id).join(", ")})`,
    request: `cedar is_authorized  (recipe/policies/travel.cedar)\n\n${JSON.stringify(verdict.request, null, 2)}`,
    response: `decision: ${verdict.decision}${reasons.length ? `\n\n${reasons.join("\n")}` : ""}`,
    status: verdict.decision === "allow" ? 200 : 403,
  });
  if (verdict.decision === "deny") {
    return {
      status: 403,
      body: {},
      refused: verdict.denied.map((d) => d.reason).join("; "),
    };
  }
  const fetchAs = createAAuthFetch({
    getKeyMaterial: r.agent!.keyMaterial,
    personServerUrl: PERSON_SERVER_URL,
    loginHint: SAM,
    ...(missionS256 ? { missionS256 } : {}),
    maxPollDuration: 600,
  });
  try {
    const response = await fetchAs(`${BOOKING_ISSUER}/v1/reserve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const answer = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    return { status: response.status, body: answer };
  } catch (err) {
    const error = err as { detail?: string; error?: string; message?: string };
    return {
      status: 403,
      body: {},
      refused: error.detail ?? error.error ?? error.message ?? "refused",
    };
  }
}

async function missionCall(agent: DemoAgent, url: string, body: unknown) {
  const response = await agent.ps(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status !== 202) return response;
  const { response: done, error } = await pollDeferred({
    signedFetch: agent.ps,
    locationUrl: new URL(response.headers.get("location")!, url).toString(),
    maxPollDuration: 600,
  });
  if (error || !done)
    throw Object.assign(
      new Error(error?.detail ?? error?.error ?? "no answer from Acme"),
      { declined: true },
    );
  return done;
}

/** A step either moves on, or ends the run early (nothing left that can happen). */
type Outcome = void | "stop";

const STEPS: Record<string, (r: Run) => Promise<Outcome>> = {
  async ask(r) {
    say("Sam", r.plan!.prompt);
    const { cabin, hotel, purpose, payer } = r.plan!;
    const cabinName = CABINS[cabin];
    const parts = [
      `${/^[aeiou]/.test(cabinName) ? "an" : "a"} ${cabinName} flight`,
      hotel
        ? hotel === "qt-sydney"
          ? "the QT Sydney"
          : "the Harbour Rocks"
        : undefined,
    ].filter(Boolean);
    say(
      "Agent",
      `I'll propose the trip to Acme so your manager can approve it once: ${parts.join(" and ")}, a ${purpose} trip paid by ${payer === "company" ? "Acme" : "you"}. Then I'll book within it.`,
    );
  },
  async propose(r) {
    say(
      "Agent",
      "I've proposed the trip to Acme. It has asked Dana to approve it and set the budget.",
    );
    let response: Response;
    try {
      response = await missionCall(
        r.agent!,
        `${PERSON_SERVER_URL}/ps/mission`,
        {
          description: `# Sam's trip to Sydney\n\n${r.plan!.prompt}`,
          resources: [BOOKING_ISSUER],
          login_hint: SAM,
        },
      );
    } catch (err) {
      if (!(err as { declined?: boolean }).declined) throw err;
      say(
        "Agent",
        `Dana didn't approve the trip (${(err as Error).message}), so I haven't booked anything.`,
      );
      return "stop";
    }
    const body = (await response.json()) as { s256: string; mission: string };
    const blob = JSON.parse(
      Buffer.from(body.mission, "base64url").toString(),
    ) as { budget_cents: number };
    r.mission = { s256: body.s256, budget_cents: blob.budget_cents };
    say(
      "Agent",
      `Dana approved the trip with a ${dollars(blob.budget_cents)} budget. I'll book within it.`,
    );
  },
  async flight(r) {
    const flight = await offer("flight", (o) => o.cabin === r.plan!.cabin);
    const name = `${String(flight.flight)}, ${CABINS[String(flight.cabin)] ?? String(flight.cabin)}`;
    const { status, body, refused } = await reserve(r, flight, r.mission!.s256);
    if (status === 200) {
      r.booked.push(name);
      say(
        "Agent",
        `Booked ${name}, for ${dollars(Number(flight.total_cents ?? 0))}: ${String(body.confirmation)}.`,
      );
    } else {
      say(
        "Agent",
        `I couldn't book ${name}: ${refused ?? `the provider answered ${status}`}.`,
      );
    }
  },
  async hotel(r) {
    const chosen = await offer("hotel", (o) => o.property === r.plan!.hotel);
    const name = String(chosen.name);
    say(
      "Agent",
      `Booking ${name} for ${dollars(Number(chosen.total_cents ?? 0))}. If that's over what's left of the budget, Acme asks Dana.`,
    );
    const { status, body, refused } = await reserve(r, chosen, r.mission!.s256);
    if (status === 200) {
      r.booked.push(name);
      say("Agent", `${name} is booked: ${String(body.confirmation)}.`);
    } else {
      say(
        "Agent",
        `I couldn't book ${name}: ${refused ?? `the provider answered ${status}`}.`,
      );
    }
  },
  async finish(r) {
    const summary = r.booked.length
      ? `Booked ${r.booked.join(" and ")}.`
      : "Nothing could be booked.";
    say(
      "Agent",
      `${summary} I've told Acme the trip is done; it's asking you to confirm.`,
    );
    try {
      const done = await missionCall(
        r.agent!,
        `${PERSON_SERVER_URL}/ps/mission/${r.mission!.s256}`,
        {
          action: "completion",
          summary,
        },
      );
      if (!done.ok) throw new Error(`completion answered ${done.status}`);
    } catch (err) {
      if (!(err as { declined?: boolean }).declined) throw err;
      say("Agent", "You didn't accept the trip as done, so it stays open.");
      return "stop";
    }
    say("Agent", "You've accepted the trip as done. The mission is closed.");
  },
};

/**
 * Sam sends a prompt: the agent works through it in the background while the
 * page polls, stopping only where Acme waits on a person to answer.
 */
export async function start(prompt: string) {
  if (run().busy) return;
  reset();
  const r = run();
  r.plan = planOf(prompt.trim() || SCENARIOS[0].prompt);
  r.busy = true;
  installRecorder();
  startRecording();
  r.eventsFrom = since(0).at(-1)?.seq ?? 0;
  r.inboxFrom = inbox().length;
  r.agent = await newAgent();
  const order = [
    "ask",
    "propose",
    "flight",
    ...(r.plan.hotel ? ["hotel"] : []),
    "finish",
  ];
  void as("Agent", async () => {
    for (const id of order) if ((await STEPS[id](r)) === "stop") return;
  })
    .catch((err: Error) => {
      r.error = err.message;
    })
    .finally(() => {
      r.busy = false;
    });
}

/** A person answers Acme's email from the page: the same call Acme's approval page makes. */
export async function decide(
  index: number,
  verdict: "approve" | "decline",
  budgetDollars?: number,
) {
  const r = run();
  const email = inbox()[index];
  if (!email || r.decided.includes(index)) return;
  const id = email.link.split("/").pop();
  const who = email.approverName.startsWith("Sam") ? "Sam" : "Dana";
  const response = await as(who, () =>
    fetch(`${PERSON_SERVER_URL}/ps/approvals/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: email.code,
        verdict,
        ...(budgetDollars ? { budget: budgetDollars } : {}),
      }),
    }),
  );
  if (!response.ok) {
    r.error = `Acme refused the decision: ${response.status}`;
    return;
  }
  r.decided.push(index);
}
