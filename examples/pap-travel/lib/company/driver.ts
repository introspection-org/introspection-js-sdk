/**
 * The boundary between Flight Sector's Poppy surface and its Company Agent:
 * a task on Introspection that the bridge starts, sends turns to and reads.
 * `introspectionAgent` is the real one, the travel-agent recipe's `poppy`
 * agent on the project's runtime, through the run the demo page follows.
 */
import "server-only";

import {
  agentToolCalls,
  send,
  snapshot,
  start,
} from "introspection-example-travel-demo-flow/demo/run";

/** What the bridge reads of a task: its lines, its tool calls, and whether it is still going. */
export type AgentState = {
  taskId?: string;
  /** The task is replying, or waiting on someone (Acme) to come back to it. */
  busy: boolean;
  /** A reply is streaming now, so a new turn has to wait. */
  streaming: boolean;
  lines: { from: string; text: string; done?: boolean }[];
  calls: { id: string; name: string; args: string; turn: number }[];
  error?: string;
};

export interface AgentDriver {
  /** A new task, acting for `member`, with its first turn. */
  start(prompt: string, shown: string, member: string): Promise<void>;
  /** The next turn; false while a reply is still streaming. */
  send(prompt: string, shown: string): Promise<boolean>;
  state(): AgentState;
}

/** The recipe agent that speaks Poppy: agents/poppy.yaml in recipe-travel-agent. */
export const POPPY_AGENT = "poppy";

export const introspectionAgent: AgentDriver = {
  async start(prompt, shown, member) {
    await start(
      prompt,
      { userId: member, agentName: POPPY_AGENT, as: "Atlas", keepWire: true },
      shown,
    );
  },
  send: (prompt, shown) => send(prompt, "Atlas", shown),
  state() {
    const run = snapshot();
    return {
      taskId: run.taskId,
      busy: run.busy,
      streaming: run.working,
      lines: run.chat,
      calls: agentToolCalls(),
      error: run.error,
    };
  },
};
