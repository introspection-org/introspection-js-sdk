/**
 * The question bank as a Streamable HTTP MCP server. No tool takes an owner:
 * the bank reads it from the call's credential (see `identity.ts`).
 */
import { nextQuestions, nextWeek, recordAnswer, summary } from "./bank";
import { record } from "./events";
import { ownerOf, Unidentified } from "./identity";
import { GENRES, type Genre, type Region } from "./questions";

type JsonRpc = {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
};

export const PROTOCOL_VERSION = "2025-06-18";

export const TOOLS = [
  {
    name: "start_night",
    description:
      "Start this venue's next quiz night. Returns its week number. Call once before the first round.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "next_questions",
    description:
      "Get questions this venue has never been asked. The bank excludes every question already asked here, so never track that yourself. When the filter runs dry it is relaxed and `relaxed` says how.",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 1, maximum: 10 },
        genre: { type: "string", enum: GENRES },
        region: { type: "string", enum: ["global", "au", "uk", "us"] },
        difficulty: { type: "integer", minimum: 1, maximum: 5 },
      },
      required: ["count"],
      additionalProperties: false,
    },
  },
  {
    name: "record_answer",
    description:
      "Record one team's answer to a served question. The bank marks it; never mark an answer yourself.",
    inputSchema: {
      type: "object",
      properties: {
        question_id: { type: "string" },
        answer: { type: "string" },
      },
      required: ["question_id", "answer"],
      additionalProperties: false,
    },
  },
  {
    name: "round_summary",
    description:
      "How this venue answered in one week, by genre and by difficulty; the current week when `week` is omitted.",
    inputSchema: {
      type: "object",
      properties: { week: { type: "integer", minimum: 1 } },
      additionalProperties: false,
    },
  },
];

const store = globalThis as unknown as { __triviaSessions?: Set<string> };
const sessions = (store.__triviaSessions ??= new Set());

const text = (value: unknown, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  ...(isError && { isError }),
});

function call(owner: string, name: string, args: Record<string, unknown>) {
  switch (name) {
    case "start_night":
      return text({ week: nextWeek(owner) });
    case "next_questions":
      return text(
        nextQuestions(
          owner,
          {
            count: Math.min(10, Math.max(1, Number(args.count) || 1)),
            genre: args.genre as Genre | undefined,
            region: args.region as Region | undefined,
            difficulty: args.difficulty ? Number(args.difficulty) : undefined,
          },
          record,
        ),
      );
    case "record_answer":
      try {
        return text(
          recordAnswer(
            owner,
            String(args.question_id),
            String(args.answer ?? ""),
            record,
          ),
        );
      } catch (error) {
        return text({ error: (error as Error).message }, true);
      }
    case "round_summary":
      return text(summary(owner, args.week ? Number(args.week) : undefined));
    default:
      return text({ error: `unknown tool ${name}` }, true);
  }
}

const sse = (message: unknown, session: string) =>
  new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
    headers: { "content-type": "text/event-stream", "mcp-session-id": session },
  });

const failure = (status: number, id: JsonRpc["id"], message: string) =>
  Response.json(
    { jsonrpc: "2.0", id: id ?? null, error: { code: -32600, message } },
    { status },
  );

export async function serve(request: Request): Promise<Response> {
  let message: JsonRpc;
  try {
    message = await request.json();
  } catch {
    return failure(400, undefined, "body must be a JSON-RPC message");
  }
  let owner: string;
  try {
    owner = await ownerOf(request);
  } catch (error) {
    if (error instanceof Unidentified)
      return failure(401, message.id, error.message);
    throw error;
  }
  if (message.method === "initialize") {
    const id = crypto.randomUUID();
    sessions.add(id);
    return sse(
      {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "trivia-bank", version: "0.1.0" },
        },
      },
      id,
    );
  }
  const id = request.headers.get("mcp-session-id") ?? "";
  if (!sessions.has(id))
    return failure(404, message.id, "unknown mcp-session-id");
  if (message.method.startsWith("notifications/"))
    return new Response(null, { status: 202 });
  if (message.method === "tools/list")
    return sse(
      { jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } },
      id,
    );
  if (message.method === "tools/call")
    return sse(
      {
        jsonrpc: "2.0",
        id: message.id,
        result: call(
          owner,
          String(message.params?.name ?? ""),
          (message.params?.arguments ?? {}) as Record<string, unknown>,
        ),
      },
      id,
    );
  return failure(400, message.id, `unsupported method ${message.method}`);
}

export function close(request: Request): Response {
  sessions.delete(request.headers.get("mcp-session-id") ?? "");
  return new Response(null, { status: 204 });
}
