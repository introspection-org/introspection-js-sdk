/**
 * Flight Sector's Company Agent, scripted so the demo runs the same way every
 * time. Signed out, it shares what anyone may know about QF74. It checks the
 * access token's scopes before it reads or changes the booking (spec 8.11),
 * and a change that costs more is an operation the user must approve first
 * (Operations extension v2, in its conversation form).
 */
import "server-only";

import { random, sha256 } from "../crypto";
import { once } from "../once";
import { supports } from "./clients";
import {
  addEvent,
  type Conversation,
  type Message,
  setStatus,
} from "./conversations";
import { challenge } from "./errors";
import type { Caller } from "./session";

export const OPTIONS = [
  {
    id: "UA863",
    flight: "UA863",
    departs: "Sat 18 Oct, 23:10",
    arrives: "Mon 20 Oct, 08:00",
    fare_difference: 0,
  },
  {
    id: "QF8",
    flight: "QF8 via Dallas",
    departs: "Sat 18 Oct, 17:40",
    arrives: "Mon 20 Oct, 06:15",
    fare_difference: 400,
  },
];
type Option = (typeof OPTIONS)[number];

const DELAYED = {
  flight: "QF74",
  route: "SFO → SYD",
  departs: "Sun 19 Oct, 03:55",
  arrives: "Mon 20 Oct, 12:40",
  delay: "6 hours",
};

const initial = () => ({
  booking: {
    reference: "FS-8Q2M",
    account: "acct_sam",
    flight: "QF74",
    seat: "41C",
  },
  changes: [] as {
    flight: string;
    at: string;
    operation_id?: string;
    revision?: string;
  }[],
});

/** What Flight Sector holds: Sam's booking, and each change it has made to it. */
export const records = once("company_records", initial);

/** Puts the booking back on QF74, for the demo's Restart. */
export function resetRecords() {
  Object.assign(records, initial());
}

/** Signs revisions, so a revision Flight Sector never returned can't be approved. */
const SECRET = once("company_operations_secret", () => random(32));
const OPERATION_TTL = 15 * 60;
const BOTH = "bookings:read bookings:write";

type Operation = {
  operation_id: string;
  revision: string;
  summary: string;
  terms: Record<string, unknown>;
  expires_at: string;
};

function say(
  conversation: Conversation,
  text: string,
  extra: Pick<Message, "data" | "extensions"> = {},
) {
  addEvent(conversation, {
    type: "message",
    message: {
      id: `msg_${random(6)}`,
      role: "company",
      author: { type: "agent", name: "Flight Sector" },
      text,
      ...extra,
    },
  });
}

/** Asks for account access in the conversation, with the matching challenge (8.11). */
function needAccess(caller: Caller, conversation: Conversation) {
  addEvent(conversation, {
    type: "authorization",
    error: "insufficient_scope",
    scope: BOTH,
  });
  return {
    challenge: caller.account
      ? challenge(BOTH, "insufficient_scope")
      : challenge(BOTH),
  };
}

const chosen = (message: Message) => {
  const asked = String(message.data?.option ?? message.text ?? "");
  return OPTIONS.find((o) => asked.includes(o.id));
};

/** The operation for moving this booking to `option`: its ID names the action, its revision these terms. */
async function operation(
  conversation: Conversation,
  option: Option,
): Promise<Operation> {
  const { booking } = records;
  const operationId = `chg_${(
    await sha256(`${conversation.id}:${booking.reference}:flight`)
  ).slice(0, 12)}`;
  const expires = Math.floor(Date.now() / 1000) + OPERATION_TTL;
  const terms = {
    booking_reference: booking.reference,
    from_flight: booking.flight,
    to_flight: option.id,
    departs: option.departs,
    arrives: option.arrives,
    fare_difference: {
      amount: option.fare_difference.toFixed(2),
      currency: "USD",
    },
    charged_to: "the card on the booking",
  };
  const signature = await sha256(
    `${SECRET}:${operationId}:${JSON.stringify(terms)}:${expires}`,
  );
  return {
    operation_id: operationId,
    revision: `${expires}-${signature.slice(0, 12)}`,
    summary: `Move booking **${booking.reference}** from ${booking.flight} to **${option.flight}**, leaving ${option.departs} and landing ${option.arrives}, for **$${option.fare_difference.toFixed(2)} more**, charged to the card on the booking.`,
    terms,
    expires_at: new Date(expires * 1000).toISOString(),
  };
}

/** The revisions of an operation that this conversation's own messages returned. */
function returned(conversation: Conversation, operationId: string) {
  return conversation.events.flatMap((e) => {
    const op =
      e.type === "message" && e.message.role === "company"
        ? (e.message.extensions?.operations?.operation as Operation | undefined)
        : undefined;
    return op?.operation_id === operationId ? [op] : [];
  });
}

function rebook(
  conversation: Conversation,
  option: Option,
  approved?: Operation,
) {
  const { booking, changes } = records;
  booking.flight = option.id;
  changes.push({
    flight: option.id,
    at: new Date().toISOString(),
    ...(approved && {
      operation_id: approved.operation_id,
      revision: approved.revision,
    }),
  });
  conversation.memory.rebooked = option.id;
  say(
    conversation,
    `Done. The user is on ${option.flight}, seat ${booking.seat}, landing ${option.arrives}. I've emailed the new itinerary.`,
    {
      data: {
        booking_reference: booking.reference,
        flight: option.flight,
        seat: booking.seat,
        arrives: option.arrives,
        fare_difference: option.fare_difference,
      },
    },
  );
}

/** The user's approval of an operation (Operations 6): the checks, then the change, at most once. */
async function approved(
  conversation: Conversation,
  approval: { operation_id?: string; revision?: string },
) {
  // 2. Already performed: a new message with the same approval adds nothing.
  if (records.changes.some((c) => c.operation_id === approval.operation_id))
    return;
  const option = OPTIONS.find((o) => o.fare_difference > 0)!;
  const current = await operation(conversation, option);
  // 3. A revision this conversation returned for this operation, not expired.
  const named = returned(conversation, current.operation_id).find(
    (op) =>
      op.operation_id === approval.operation_id &&
      op.revision === approval.revision,
  );
  if (!named || Date.parse(named.expires_at) < Date.now()) {
    say(
      conversation,
      "Those terms are no longer on offer. Here they are again, for the user to approve.",
      { extensions: { operations: { operation: current } } },
    );
    return;
  }
  const target = OPTIONS.find((o) => o.id === named.terms.to_flight)!;
  rebook(conversation, target, named);
}

export async function reply(
  caller: Caller,
  conversation: Conversation,
  message: Message,
): Promise<{ challenge?: string }> {
  // A context-only update says nothing new.
  if (!message.text && !message.data && !message.extensions) return {};
  const approval = message.extensions?.operations?.approval as
    { operation_id?: string; revision?: string } | undefined;
  const result = await respondTo(caller, conversation, message, approval);
  setStatus(conversation, "idle");
  return result;
}

async function respondTo(
  caller: Caller,
  conversation: Conversation,
  message: Message,
  approval?: { operation_id?: string; revision?: string },
): Promise<{ challenge?: string }> {
  const { booking } = records;
  if (!caller.scopes.includes("bookings:read")) {
    if (!conversation.memory.shared) {
      conversation.memory.shared = true;
      say(
        conversation,
        `QF74 is delayed ${DELAYED.delay}: it now leaves ${DELAYED.departs} and lands ${DELAYED.arrives}. UA863 and QF8 via Dallas both land before 9am on the 20th. To look up the user's booking and move it, I need access to their account.`,
        { data: { flight_status: DELAYED } },
      );
    } else
      say(
        conversation,
        "To look up the user's booking, I need access to their account.",
      );
    return needAccess(caller, conversation);
  }

  // 1. Only a Session signed in to the booking's account can approve its change.
  if (approval && caller.account === booking.account) {
    await approved(conversation, approval);
    return {};
  }

  if (conversation.memory.rebooked) {
    say(
      conversation,
      `The booking is already on ${conversation.memory.rebooked}. Anything else?`,
    );
    return {};
  }

  const option = conversation.memory.offered ? chosen(message) : undefined;
  if (!option) {
    conversation.memory.offered = true;
    say(
      conversation,
      `I found booking ${booking.reference}. Two flights land before 9am on the 20th: UA863 at no extra cost, or QF8 via Dallas for $400 more.`,
      {
        data: {
          booking: { ...booking, delayed: DELAYED },
          options: OPTIONS,
        },
      },
    );
    return {};
  }

  if (!caller.scopes.includes("bookings:write")) {
    say(conversation, "Changing the booking needs permission to change it.");
    return needAccess(caller, conversation);
  }

  if (option.fare_difference === 0) {
    rebook(conversation, option);
    return {};
  }

  // A change that costs more waits for the user's approval of its exact terms.
  if (!supports(caller.metadata, "operations", "2")) {
    say(
      conversation,
      `QF8 via Dallas costs $${option.fare_difference} more. The user can approve it on our website, and I'll change it then.`,
    );
    return {};
  }
  say(
    conversation,
    `QF8 via Dallas costs $${option.fare_difference} more. I'll move the booking once the user approves these terms.`,
    {
      extensions: {
        operations: { operation: await operation(conversation, option) },
      },
    },
  );
  return {};
}
