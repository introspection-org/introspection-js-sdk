/**
 * Flight Sector's PAP conversations (spec §7): start, message, read events and
 * close. A conversation belongs to the client and User ID that started it, and
 * to the account once it has used one. The replies come from `agent.ts`.
 */
import "server-only";

import { base64url } from "jose";

import { once } from "../once";
import { reply } from "./agent";
import { type Caller, CONVERSATIONS, OAuthError } from "./oauth";

export type Message = {
  id: string;
  role: "user" | "company";
  sender: "agent" | "human";
  text?: string;
  data?: Record<string, unknown>;
  context?: Record<string, unknown>;
};

export type ConversationEvent =
  | { id: string; type: "message"; created_at: string; message: Message }
  | {
      id: string;
      type: "state";
      created_at: string;
      status: Status;
      responder: "agent";
    }
  | {
      id: string;
      type: "authorization";
      created_at: string;
      error: string;
      scope?: string;
    };

type Status = "working" | "idle" | "closed";

export type Conversation = {
  id: string;
  clientId: string;
  userId: string;
  account?: string;
  status: Status;
  events: ConversationEvent[];
  /** What the scripted agent has done so far. */
  memory: { offered?: boolean; rebooked?: string };
};

const state = once("company_conversations", () => ({
  conversations: new Map<string, Conversation>(),
  /** Message IDs are unique per User: the retried message and the response it got. */
  accepted: new Map<string, { body: string; conversationId: string }>(),
}));

const random = (prefix: string) =>
  `${prefix}${base64url.encode(crypto.getRandomValues(new Uint8Array(6)))}`;

type NewEvent = ConversationEvent extends infer E
  ? E extends ConversationEvent
    ? Omit<E, "id" | "created_at">
    : never
  : never;

export function addEvent(conversation: Conversation, event: NewEvent) {
  conversation.events.push({
    id: random("evt_"),
    created_at: new Date().toISOString(),
    ...event,
  } as ConversationEvent);
}

function owned(caller: Caller, id: string): Conversation {
  const conversation = state.conversations.get(id);
  if (
    !conversation ||
    conversation.clientId !== caller.clientId ||
    conversation.userId !== caller.userId
  )
    throw new OAuthError(404, "conversation_not_found", "no such conversation");
  if (conversation.account && caller.session.account !== conversation.account)
    throw new OAuthError(
      403,
      "sign_in_required",
      "this conversation uses the user's account",
    );
  return conversation;
}

function readMessage(body: Record<string, unknown>): Message {
  const message = body.message as Partial<Message> | undefined;
  if (
    !message ||
    typeof message.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(message.id)
  )
    throw new OAuthError(400, "invalid_request", "message.id is required");
  if (message.sender !== "agent" && message.sender !== "human")
    throw new OAuthError(
      400,
      "invalid_request",
      "message.sender is agent or human",
    );
  if (!message.text && !message.data && !message.context)
    throw new OAuthError(
      400,
      "invalid_request",
      "a message needs text, data or context",
    );
  return {
    id: message.id,
    role: "user",
    sender: message.sender,
    ...(message.text && { text: message.text }),
    ...(message.data && { data: message.data }),
    ...(message.context && { context: message.context }),
  };
}

/** A read of events after `cursor` (spec §7.5). Replies are scripted, so `wait` never has to wait. */
export function read(conversation: Conversation, cursor: string | null) {
  let start = 0;
  if (cursor) {
    const at = conversation.events.findIndex((e) => e.id === cursor);
    if (at < 0) throw new OAuthError(400, "invalid_cursor", "unknown cursor");
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

function accept(caller: Caller, conversation: Conversation, message: Message) {
  addEvent(conversation, { type: "message", message });
  reply(caller, conversation, message);
}

function remembered(caller: Caller, message: Message): Conversation | null {
  const key = `${caller.clientId}\n${caller.userId}\n${message.id}`;
  const body = JSON.stringify(message);
  const earlier = state.accepted.get(key);
  if (!earlier) return null;
  if (earlier.body !== body)
    throw new OAuthError(
      409,
      "message_id_conflict",
      "that message id carried other content",
    );
  return state.conversations.get(earlier.conversationId) ?? null;
}

function remember(
  caller: Caller,
  message: Message,
  conversation: Conversation,
) {
  state.accepted.set(`${caller.clientId}\n${caller.userId}\n${message.id}`, {
    body: JSON.stringify(message),
    conversationId: conversation.id,
  });
}

function answer(conversation: Conversation, url: URL, status: number) {
  const body = url.searchParams.has("wait")
    ? read(conversation, url.searchParams.get("cursor"))
    : {
        conversation_id: conversation.id,
        status: conversation.status,
        responder: "agent",
      };
  return Response.json(body, { status });
}

export function start(caller: Caller, body: Record<string, unknown>, url: URL) {
  const message = readMessage(body);
  const again = remembered(caller, message);
  if (again) return answer(again, url, 201);
  const conversation: Conversation = {
    id: random("cnv_"),
    clientId: caller.clientId,
    userId: caller.userId,
    status: "working",
    events: [],
    memory: {},
  };
  state.conversations.set(conversation.id, conversation);
  remember(caller, message, conversation);
  accept(caller, conversation, message);
  return answer(conversation, url, 201);
}

export function send(
  caller: Caller,
  id: string,
  body: Record<string, unknown>,
  url: URL,
) {
  const message = readMessage(body);
  const again = remembered(caller, message);
  if (again) return answer(again, url, 202);
  const conversation = owned(caller, id);
  if (conversation.status === "closed")
    throw new OAuthError(
      409,
      "conversation_closed",
      "the conversation is closed",
    );
  remember(caller, message, conversation);
  accept(caller, conversation, message);
  return answer(conversation, url, 202);
}

export function events(caller: Caller, id: string, url: URL) {
  return Response.json(read(owned(caller, id), url.searchParams.get("cursor")));
}

export function close(caller: Caller, id: string) {
  const conversation = owned(caller, id);
  if (conversation.status !== "closed") {
    conversation.status = "closed";
    addEvent(conversation, {
      type: "state",
      status: "closed",
      responder: "agent",
    });
  }
  return Response.json({ status: "closed", responder: "agent" });
}

export const conversationUrl = (id?: string, tail = "") =>
  `${CONVERSATIONS}${id ? `/${id}` : ""}${tail}`;
