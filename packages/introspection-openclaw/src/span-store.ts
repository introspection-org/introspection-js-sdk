import type { Span, Context } from "@opentelemetry/api";

export interface LlmSpanEntry {
  span: Span;
  ctx: Context;
  runId: string;
  provider: string;
  model: string;
  startTime: number;
}

export interface ToolSpanEntry {
  span: Span;
  ctx: Context;
  name: string;
  startTime: number;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  arguments?: string;
  result?: string;
}

export interface SessionContext {
  agentSpan: Span;
  agentCtx: Context;
  toolStack: ToolSpanEntry[];
  llmSpans: Map<string, LlmSpanEntry>;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  toolSequence: number;
  /** Accumulated tool calls across the session (for output message reconstruction). */
  toolCalls: ToolCallRecord[];
  model?: string;
  provider?: string;
  startTime: number;
}

const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

class SpanStore {
  private sessions = new Map<string, SessionContext>();

  set(sessionKey: string, ctx: SessionContext): void {
    this.sessions.set(sessionKey, ctx);
    this.cleanup();
  }

  get(sessionKey: string): SessionContext | undefined {
    return this.sessions.get(sessionKey);
  }

  delete(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }

  pushTool(sessionKey: string, entry: ToolSpanEntry): void {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    session.toolStack.push(entry);
  }

  popTool(sessionKey: string): ToolSpanEntry | undefined {
    const session = this.sessions.get(sessionKey);
    if (!session) return undefined;
    return session.toolStack.pop();
  }

  setLlmSpan(sessionKey: string, runId: string, entry: LlmSpanEntry): void {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    session.llmSpans.set(runId, entry);
  }

  deleteLlmSpan(sessionKey: string, runId: string): LlmSpanEntry | undefined {
    const session = this.sessions.get(sessionKey);
    if (!session) return undefined;
    const entry = session.llmSpans.get(runId);
    if (entry) session.llmSpans.delete(runId);
    return entry;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.startTime > MAX_AGE_MS) {
        // Close children before parent (LIFO)
        for (let i = session.toolStack.length - 1; i >= 0; i--) {
          session.toolStack[i]!.span.end();
        }
        for (const llm of [...session.llmSpans.values()].reverse()) {
          llm.span.end();
        }
        session.agentSpan.end();
        this.sessions.delete(key);
      }
    }
  }
}

export const spanStore = new SpanStore();
