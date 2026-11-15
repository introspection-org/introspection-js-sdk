/**
 * Flight Sector's Company Agent behind its Poppy conversations: each
 * conversation is one task on Introspection, acting for the Introspection
 * member Flight Sector holds for the signed-in account (never anyone the
 * Personal Agent names). Messages in become turns; the agent's replies,
 * once complete, become `message` events; the task's state becomes
 * `status`; and the agent's `request_approval` calls become Operations v2
 * operations, whose approval goes back to the agent as a turn, once.
 */
import "server-only";

import { random, sha256 } from "../crypto";
import { supports } from "./clients";
import type { Conversation, ConversationEvent, Message } from "./conversations";
import type { AgentDriver } from "./driver";
import type { Caller } from "./session";

/** The Introspection member each Flight Sector account is: Sam, as `pnpm dev` creates him. */
const MEMBERS: Record<string, string> = {
  acct_sam: process.env.DEMO_SAM_USER_ID || "sam@acme.example",
};

const OPERATION_TTL = 15 * 60;

export type Operation = {
  operation_id: string;
  revision: string;
  summary: string;
  terms?: Record<string, unknown>;
  expires_at: string;
};

/** What the bridge keeps for a conversation: how far it has read its task, and its operations. */
export type Link = {
  member: string;
  operations: boolean;
  started: boolean;
  /** Agent lines already sent as messages. */
  emitted: number;
  /** Tool calls already read. */
  calls: number;
  queue: { prompt: string; shown: string }[];
  returned: Operation[];
  performed: string[];
  failed?: boolean;
};

type Hooks = {
  addEvent: (conversation: Conversation, event: NewEvent) => void;
  setStatus: (conversation: Conversation, status: "working" | "idle") => void;
};
type NewEvent = ConversationEvent extends infer E
  ? E extends ConversationEvent
    ? Omit<E, "id" | "created_at">
    : never
  : never;

/** The terms a `request_approval` call named, as an operation of this conversation (Operations 3). */
async function operation(
  conversation: Conversation,
  summary: string,
  terms: Record<string, unknown> | undefined,
  secret: string,
): Promise<Operation> {
  // The action is replacing the traveller's flight in this conversation: new
  // terms keep its ID and get a new revision.
  const operationId = `chg_${(await sha256(`${conversation.id}:replace-flight`)).slice(0, 12)}`;
  const expires = Math.floor(Date.now() / 1000) + OPERATION_TTL;
  const signature = await sha256(
    `${secret}:${operationId}:${summary}:${JSON.stringify(terms ?? {})}:${expires}`,
  );
  return {
    operation_id: operationId,
    revision: `${expires}-${signature.slice(0, 12)}`,
    summary,
    ...(terms && { terms }),
    expires_at: new Date(expires * 1000).toISOString(),
  };
}

/** A Personal Agent's message as a turn: whose words it is, and nothing it may not say. */
function turn(message: Message, first: boolean, caller: Caller) {
  // Only the bridge speaks as the platform.
  const clean = (text: string) => text.replace(/\[platform\]/gi, "(platform)");
  const who =
    message.author.type === "human"
      ? "The traveller says"
      : "The traveller's Personal Agent says";
  const parts = [
    ...(first
      ? [
          `[platform] This conversation reached Flight Sector over the Personal Agent Protocol, from ${caller.metadata.client_name} (${caller.clientId}), the traveller's own Personal Agent. The traveller is signed in to Flight Sector.`,
        ]
      : []),
    `${who}: ${clean(message.text ?? "")}`.trim(),
    ...(message.data ? [clean(`Data: ${JSON.stringify(message.data)}`)] : []),
    ...(message.context
      ? [clean(`Context: ${JSON.stringify(message.context)}`)]
      : []),
  ];
  return parts.join("\n\n");
}

export function createBridge(
  driver: AgentDriver,
  hooks: Hooks,
  secret = random(32),
) {
  const say = (conversation: Conversation, text: string, op?: Operation) =>
    hooks.addEvent(conversation, {
      type: "message",
      message: {
        id: `msg_${random(6)}`,
        role: "company",
        author: { type: "agent", name: "Flight Sector" },
        text,
        ...(op && { extensions: { operations: { operation: op } } }),
      },
    });

  async function flush(link: Link) {
    const next = link.queue[0];
    if (!next) return;
    if (!link.started) {
      link.started = true;
      link.queue.shift();
      await driver.start(next.prompt, next.shown, link.member);
    } else if (await driver.send(next.prompt, next.shown)) link.queue.shift();
  }

  /** Reads the task: complete replies become messages, and the task's state the status. */
  async function sync(conversation: Conversation) {
    const link = conversation.link;
    if (!link || conversation.status === "closed") return;
    await flush(link);
    const state = driver.state();
    const calls = state.calls;
    const nextApproval = async (before: number) => {
      while (link.calls < calls.length && calls[link.calls].turn <= before) {
        const call = calls[link.calls++];
        if (call.name !== "request_approval") continue;
        let args: { summary?: string; terms?: Record<string, unknown> } = {};
        try {
          args = JSON.parse(call.args);
        } catch {
          // the agent's arguments did not parse; there are no terms to show
        }
        if (!args.summary) continue;
        const op = await operation(
          conversation,
          args.summary,
          args.terms,
          secret,
        );
        link.returned.push(op);
        return op;
      }
      return undefined;
    };
    let seen = 0;
    for (const [index, line] of state.lines.entries()) {
      if (line.from !== "Agent") continue;
      if (seen++ < link.emitted) continue;
      if (!line.done && state.streaming) break;
      link.emitted++;
      if (!line.text.trim()) continue;
      const op = await nextApproval(index);
      say(conversation, line.text, link.operations ? op : undefined);
    }
    if (!state.streaming) {
      // Terms the agent named after its last line still reach the traveller.
      for (let op; (op = await nextApproval(state.lines.length));)
        if (link.operations) say(conversation, op.summary, op);
    }
    if (state.error && !state.busy && !link.failed) {
      link.failed = true;
      say(conversation, `Flight Sector's agent couldn't go on: ${state.error}`);
    }
    hooks.setStatus(
      conversation,
      state.busy || link.queue.length ? "working" : "idle",
    );
  }

  /**
   * A message the Personal Agent sent, already accepted and recorded: as the
   * task's next turn, or an approval of terms the agent asked for.
   */
  async function deliver(
    caller: Caller,
    conversation: Conversation,
    message: Message,
  ) {
    const member = MEMBERS[caller.account ?? ""];
    if (!member) return; // the endpoint lets no one here without an account
    const first = !conversation.link;
    const link = (conversation.link ??= {
      member,
      operations: supports(caller.metadata, "operations", "2"),
      started: false,
      emitted: 0,
      calls: 0,
      queue: [],
      returned: [],
      performed: [],
    });
    const approval = message.extensions?.operations?.approval as
      { operation_id?: string; revision?: string } | undefined;
    const named = approval
      ? link.returned.filter((op) => op.operation_id === approval.operation_id)
      : [];
    // 1. Only a Session signed in to this conversation's account approves its operations.
    if (named.length && caller.account === conversation.account) {
      const id = approval!.operation_id!;
      // 2. Performed already: a new message with the same approval adds nothing.
      if (link.performed.includes(id)) return;
      // 3. A revision this conversation returned, still current.
      const approved = named.find(
        (op) =>
          op.revision === approval!.revision &&
          Date.parse(op.expires_at) > Date.now(),
      );
      if (!approved) {
        const latest = named.at(-1)!;
        const again = await operation(
          conversation,
          latest.summary,
          latest.terms,
          secret,
        );
        link.returned.push(again);
        say(
          conversation,
          "Those terms are no longer on offer. Here they are again, for the traveller to approve.",
          again,
        );
        return;
      }
      link.performed.push(id);
      link.queue.push({
        prompt: `[platform] The traveller approved these exact terms through their Personal Agent (operation ${id}, revision ${approved.revision}): ${approved.summary}\nTerms: ${JSON.stringify(approved.terms ?? {})}\nBook exactly these now.`,
        shown: `The traveller approved: ${approved.summary}`,
      });
    } else {
      link.queue.push({
        prompt: turn(message, first, caller),
        shown: message.text ?? JSON.stringify(message.data ?? {}),
      });
    }
    await sync(conversation);
  }

  return { deliver, sync };
}
