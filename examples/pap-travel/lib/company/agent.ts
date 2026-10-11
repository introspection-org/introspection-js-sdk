/**
 * Flight Sector's Company Agent, scripted so the demo runs the same way every
 * time. It answers general questions signed out, asks for sign-in when it
 * needs Sam's booking, and checks the token's scopes before it changes
 * anything (spec §7.11).
 */
import "server-only";

import { addEvent, type Conversation, type Message } from "./conversations";
import type { Caller } from "./oauth";

export const BOOKING = {
  reference: "FS-8Q2M",
  flight: "QF74",
  route: "SFO → SYD",
  departs: "Sat 18 Oct, 21:55",
  arrives: "Mon 20 Oct, 06:40",
  delay: "6 hours",
};

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

function say(
  conversation: Conversation,
  text: string,
  data?: Record<string, unknown>,
) {
  addEvent(conversation, {
    type: "message",
    message: {
      id: `msg_${crypto.randomUUID().slice(0, 8)}`,
      role: "company",
      sender: "agent",
      text,
      ...(data && { data }),
    },
  });
}

function settle(conversation: Conversation) {
  conversation.status = "idle";
  addEvent(conversation, { type: "state", status: "idle", responder: "agent" });
}

function chosen(message: Message) {
  const asked = String(message.data?.option ?? message.text ?? "");
  return OPTIONS.find((o) => asked.includes(o.id));
}

export function reply(
  caller: Caller,
  conversation: Conversation,
  message: Message,
) {
  if (!message.text && !message.data) return; // a context-only update says nothing new

  if (!caller.scopes.includes("poppy:read")) {
    say(
      conversation,
      "I can help with QF74. To find the user's booking, they need to sign in.",
    );
    addEvent(conversation, {
      type: "authorization",
      error: caller.session.account ? "insufficient_scope" : "sign_in_required",
      ...(caller.session.account && { scope: "poppy:read poppy:write" }),
    });
    return settle(conversation);
  }
  conversation.account = caller.session.account;

  const option = conversation.memory.offered ? chosen(message) : undefined;
  if (!option) {
    conversation.memory.offered = true;
    say(
      conversation,
      `I found booking ${BOOKING.reference}. QF74 is delayed ${BOOKING.delay}, so it lands after 9am on the 20th. Two flights get there sooner: UA863 at no extra cost, or QF8 via Dallas for $400 more.`,
      { booking: BOOKING, options: OPTIONS },
    );
    return settle(conversation);
  }

  if (!caller.scopes.includes("poppy:write")) {
    say(
      conversation,
      "Changing the booking needs the user's permission to make changes.",
    );
    addEvent(conversation, {
      type: "authorization",
      error: "insufficient_scope",
      scope: "poppy:read poppy:write",
    });
    return settle(conversation);
  }

  conversation.memory.rebooked = option.id;
  say(
    conversation,
    `Done. The user is on ${option.flight}, seat 41C, landing ${option.arrives}. I've emailed the new itinerary.`,
    {
      booking_reference: BOOKING.reference,
      flight: option.flight,
      seat: "41C",
      fare_difference: option.fare_difference,
    },
  );
  settle(conversation);
}
