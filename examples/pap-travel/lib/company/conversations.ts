/**
 * Flight Sector's Poppy conversations (spec 8): start, send, read events,
 * hand off and close. A conversation belongs to the client and User ID that
 * started it, and to the account once it uses one (8.2). The replies come
 * from `agent.ts`.
 */
import "server-only";

import { random, sha256 } from "../crypto";
import { once } from "../once";
import { reply } from "./agent";
import { challenge, PoppyError } from "./errors";
import { CONVERSATIONS } from "./oauth";
import type { Caller } from "./session";

export type Message = {
  id: string;
  role: "user" | "company";
  author: { type: "agent" | "human"; id?: string; name?: string };
  text?: string;
  data?: Record<string, unknown>;
  context?: Record<string, unknown>;
  extensions?: Record<string, Record<string, unknown>>;
};

type Status = "working" | "idle" | "queued" | "closed";
type Base = { id: string; created_at: string };
export type ConversationEvent = Base &
  (
    | { type: "message"; message: Message }
    | { type: "state"; status: Status; responder: "agent" }
    | { type: "authorization"; error: "insufficient_scope"; scope: string }
  );
type NewEvent = ConversationEvent extends infer E
  ? E extends ConversationEvent
    ? Omit<E, "id" | "created_at">
    : never
  : never;

export type Conversation = {
  id: string;
  clientId: string;
  userId: string;
  account?: string;
  status: Status;
  events: ConversationEvent[];
  /** What the scripted agent has done so far. */
  memory: { shared?: boolean; offered?: boolean; rebooked?: string };
};

type Reply = { status: number; body: unknown; challenge?: string };

const state = once("company_conversations", () => ({
  conversations: new Map<string, Conversation>(),
  /** Message IDs are unique per User: each accepted one, its content's hash, and the response it got (8.3). */
  accepted: new Map<string, { hash: string; reply: Reply }>(),
}));

const ID = /^[A-Za-z0-9_-]{1,256}$/;
const READ_SCOPE = "bookings:read";

export function addEvent(conversation: Conversation, event: NewEvent) {
  conversation.events.push({
    id: `evt_${random(6)}`,
    created_at: new Date().toISOString(),
    ...event,
  } as ConversationEvent);
}

/** Changes `status`, with the `state` event every change adds (8.7). */
export function setStatus(conversation: Conversation, status: Status) {
  if (conversation.status === status) return;
  conversation.status = status;
  addEvent(conversation, { type: "state", status, responder: "agent" });
}

/** The conversation, if this request may continue it: the ownership table of 8.2. */
function owned(caller: Caller, id: string): Conversation {
  const conversation = state.conversations.get(id);
  if (
    !conversation ||
    conversation.clientId !== caller.clientId ||
    conversation.userId !== caller.userId
  )
    throw new PoppyError(404, "conversation_not_found", "no such conversation");
  if (conversation.account) {
    if (!caller.account)
      throw new PoppyError(
        401,
        null,
        "this conversation uses the user's account",
        challenge(READ_SCOPE),
      );
    if (caller.account !== conversation.account)
      throw new PoppyError(
        404,
        "conversation_not_found",
        "no such conversation",
      );
  } else if (caller.account) conversation.account = caller.account;
  return conversation;
}

function readMessage(body: Record<string, unknown>): Message {
  const message = body.message as Partial<Message> | undefined;
  const bad = (why: string) => new PoppyError(400, "invalid_request", why);
  if (!message || typeof message !== "object") throw bad("message is required");
  if (typeof message.id !== "string" || !ID.test(message.id))
    throw bad("message.id is 1 to 256 URL-safe base64 characters");
  const type = message.author?.type;
  if (type !== "agent" && type !== "human")
    throw bad("message.author.type is agent or human");
  if (!message.text && !message.data && !message.context && !message.extensions)
    throw bad("a message needs text, data, context or extensions");
  // `role` is the Company's to set; anything else the client sent is ignored.
  return {
    id: message.id,
    role: "user",
    author: { type },
    ...(typeof message.text === "string" && { text: message.text }),
    ...(message.data && { data: message.data }),
    ...(message.context && { context: message.context }),
    ...(message.extensions && { extensions: message.extensions }),
  };
}

function waitParam(url: URL) {
  const wait = url.searchParams.get("wait");
  if (wait !== null && !/^\d+$/.test(wait))
    throw new PoppyError(
      400,
      "invalid_request",
      "wait is a whole number of seconds",
    );
}

/** A read of events after `cursor` (8.5). Replies are scripted, so `wait` never has to wait. */
function read(conversation: Conversation, cursor: string | null) {
  let start = 0;
  if (cursor) {
    const at = conversation.events.findIndex((e) => e.id === cursor);
    if (at < 0) throw new PoppyError(400, "invalid_cursor", "unknown cursor");
    start = at + 1;
  }
  const events = conversation.events.slice(start);
  return {
    conversation_id: conversation.id,
    events,
    cursor: events.at(-1)?.id ?? cursor,
    has_more: false,
    status: conversation.status,
    responder: "agent" as const,
  };
}

function answer(
  conversation: Conversation,
  url: URL,
  status: number,
  challengeHeader?: string,
): Reply {
  const body = url.searchParams.has("wait")
    ? read(conversation, url.searchParams.get("cursor"))
    : {
        conversation_id: conversation.id,
        status: conversation.status,
        responder: "agent",
      };
  return { status, body, challenge: challengeHeader };
}

function toResponse(reply: Reply) {
  return Response.json(reply.body, {
    status: reply.status,
    headers: reply.challenge ? { "WWW-Authenticate": reply.challenge } : {},
  });
}

const messageKey = (caller: Caller, message: Message) =>
  `${caller.clientId}\n${caller.userId}\n${message.id}`;

/** The original response to a retried message, or a conflict if its content changed (8.3). */
async function retried(caller: Caller, message: Message) {
  const earlier = state.accepted.get(messageKey(caller, message));
  if (!earlier) return undefined;
  if (earlier.hash !== (await sha256(JSON.stringify(message))))
    throw new PoppyError(
      409,
      "message_id_conflict",
      "that message ID was accepted with other content",
    );
  return earlier.reply;
}

async function accept(
  caller: Caller,
  conversation: Conversation,
  message: Message,
  url: URL,
  status: number,
) {
  addEvent(conversation, { type: "message", message });
  const { challenge: header } = await reply(caller, conversation, message);
  const result = answer(conversation, url, status, header);
  state.accepted.set(messageKey(caller, message), {
    hash: await sha256(JSON.stringify(message)),
    reply: result,
  });
  return toResponse(result);
}

/** `POST {endpoint}`: a new conversation and its first message (8.3). */
export async function start(
  caller: Caller,
  body: Record<string, unknown>,
  url: URL,
) {
  waitParam(url);
  if (body.parent_conversation_id || body.user_requested_event_id)
    throw new PoppyError(
      400,
      "invalid_request",
      "Flight Sector doesn't offer Direct Conversations",
    );
  const message = readMessage(body);
  const again = await retried(caller, message);
  if (again) return toResponse(again);
  const conversation: Conversation = {
    id: `cnv_${random(9)}`,
    clientId: caller.clientId,
    userId: caller.userId,
    account: caller.account,
    status: "working",
    events: [],
    memory: {},
  };
  state.conversations.set(conversation.id, conversation);
  return accept(caller, conversation, message, url, 201);
}

/** `POST {endpoint}/{id}/messages` (8.3). */
export async function send(
  caller: Caller,
  id: string,
  body: Record<string, unknown>,
  url: URL,
) {
  waitParam(url);
  const message = readMessage(body);
  const conversation = owned(caller, id);
  const again = await retried(caller, message);
  if (again) return toResponse(again);
  if (conversation.status === "closed")
    throw new PoppyError(
      409,
      "conversation_closed",
      "the conversation is closed",
    );
  return accept(caller, conversation, message, url, 202);
}

/** `GET {endpoint}/{id}/events` (8.5). */
export function events(caller: Caller, id: string, url: URL) {
  waitParam(url);
  return Response.json(read(owned(caller, id), url.searchParams.get("cursor")));
}

/** `POST {endpoint}/{id}/handoff` (8.9): no one is free in this demo, so it goes back to idle. */
export function handoff(caller: Caller, id: string) {
  const conversation = owned(caller, id);
  if (conversation.status === "closed")
    throw new PoppyError(
      409,
      "conversation_closed",
      "the conversation is closed",
    );
  setStatus(conversation, "queued");
  addEvent(conversation, {
    type: "message",
    message: {
      id: `msg_${random(6)}`,
      role: "company",
      author: { type: "agent", name: "Flight Sector" },
      text: "No one on the team is free right now. I can keep helping, or the user can call us.",
    },
  });
  setStatus(conversation, "idle");
  return Response.json(
    { conversation_id: id, status: conversation.status, responder: "agent" },
    { status: 202 },
  );
}

/** `POST {endpoint}/{id}/close` (8.12): idempotent, 200. */
export function close(caller: Caller, id: string) {
  const conversation = owned(caller, id);
  setStatus(conversation, "closed");
  return Response.json({
    conversation_id: id,
    status: "closed",
    responder: "agent",
  });
}

export const conversationUrl = (id?: string, tail = "") =>
  `${CONVERSATIONS}${id ? `/${id}` : ""}${tail}`;
