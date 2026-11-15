/**
 * A stand-in for Browserbase's hosted MCP, so the demo can search flights with
 * no Browserbase account. It speaks the same Streamable HTTP MCP: the same
 * tools with the same input schemas, the same `{"success":true,"data":...}`
 * text results, answered as server-sent events under an `mcp-session-id`.
 * Pages are not browsed: `extract` returns what the real search returned for a
 * recorded route, and otherwise lists the booking provider's own flights.
 */
import "server-only";

import {
  CAPABILITIES,
  PROTOCOL_VERSION,
  RECORDED_SEARCHES,
  TOOLS,
} from "./browserbase-recording";
import { flights } from "./world";

type Session = { browser?: string; url?: string };
type JsonRpc = {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
};

const store = globalThis as unknown as {
  __browserbaseSessions?: Map<string, Session>;
};
const sessions = (store.__browserbaseSessions ??= new Map());

const AIRLINES: Record<string, string> = { QF: "Qantas", UA: "United" };

const text = (value: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

/** "Flights from SFO to SYD on 2026-10-18 one way economy" → its route. */
function route(url: string): { from: string; to: string } | undefined {
  const query = new URL(url).searchParams.get("q") ?? "";
  const match = /from\s+([A-Z]{3})\s+to\s+([A-Z]{3})/i.exec(query);
  return match
    ? { from: match[1].toUpperCase(), to: match[2].toUpperCase() }
    : undefined;
}

function clock(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** The page for a search: recorded where we have one, else this provider's flights. */
function extraction(url: string): string {
  const searched = route(url);
  if (!searched) return "[]";
  const recorded = RECORDED_SEARCHES.find(
    (r) => r.from === searched.from && r.to === searched.to,
  );
  if (recorded) return recorded.extraction;
  return JSON.stringify(
    flights
      .filter((f) => f.from === searched.from && f.to === searched.to)
      .map((f) => ({
        airline: AIRLINES[f.carrier] ?? f.carrier,
        flight_numbers: null,
        departure_time: clock(f.depart_time),
        duration: `${Math.floor(f.block_minutes / 60)} hr ${f.block_minutes % 60} min`,
        stops: f.stops ? `${f.stops} stop` : "Nonstop",
        price: `$${Math.round(f.fares_cents.economy / 100).toLocaleString("en-US")}`,
      })),
  );
}

function call(
  session: Session,
  name: string,
  args: Record<string, unknown>,
): ReturnType<typeof text> & { isError?: boolean } {
  const actionId = crypto.randomUUID();
  switch (name) {
    case "start":
      session.browser =
        typeof args.sessionId === "string"
          ? args.sessionId
          : crypto.randomUUID();
      return text({
        success: true,
        data: {
          sessionId: session.browser,
          cdpUrl: `wss://connect.browserbase.example/?session=${session.browser}`,
          available: true,
        },
      });
    case "navigate":
      if (!session.browser) break;
      session.url = String(args.url);
      return text({
        success: true,
        data: { result: { url: session.url, status: 200 }, actionId },
      });
    case "extract":
      if (!session.browser || !session.url) break;
      return text({
        success: true,
        data: { result: { extraction: extraction(session.url) }, actionId },
      });
    case "observe":
      if (!session.browser) break;
      return text({ success: true, data: { result: [], actionId } });
    case "act":
      if (!session.browser) break;
      return text({
        success: true,
        data: {
          result: {
            success: true,
            message: "no-op in the mock",
            action: args.action,
          },
          actionId,
        },
      });
    case "end":
      session.browser = undefined;
      session.url = undefined;
      return text({ success: true });
    default:
      return {
        ...text({ success: false, error: `unknown tool ${name}` }),
        isError: true,
      };
  }
  return {
    ...text({
      success: false,
      error: "no active session: call start, then navigate",
    }),
    isError: true,
  };
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
  if (message.method === "initialize") {
    const id = crypto.randomUUID();
    sessions.set(id, {});
    return sse(
      {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: CAPABILITIES,
          serverInfo: { name: "stagehand-api", version: "flightsector-mock" },
        },
      },
      id,
    );
  }
  const id = request.headers.get("mcp-session-id") ?? "";
  const session = sessions.get(id);
  if (!session) return failure(404, message.id, "unknown mcp-session-id");
  if (message.method.startsWith("notifications/"))
    return new Response(null, { status: 202 });
  if (message.method === "tools/list")
    return sse(
      { jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } },
      id,
    );
  if (message.method === "tools/call") {
    const name = String(message.params?.name ?? "");
    // Browserbase refuses to start a browser without the account's key.
    if (name === "start" && !request.headers.get("authorization"))
      return failure(400, message.id, "missing Browserbase API key");
    const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
    return sse(
      { jsonrpc: "2.0", id: message.id, result: call(session, name, args) },
      id,
    );
  }
  return failure(400, message.id, `unsupported method ${message.method}`);
}

export function close(request: Request): Response {
  sessions.delete(request.headers.get("mcp-session-id") ?? "");
  return new Response(null, { status: 204 });
}
