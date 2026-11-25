/**
 * The bank alone, as a plain HTTP server: the MCP server at /mcp and the rooms
 * API at /rooms. An eval's sidecar runs it with TRIVIA_DEV_OWNER naming the
 * one venue every call is for, since a trial carries no end-user token.
 * `pnpm dev` runs it with TRIVIA_BANK_MCP_ONLY=1 on loopback behind its
 * tunnel, so only /mcp is public.
 */
import { createServer } from "node:http";

import { close, serve } from "../lib/mcp";
import { roomState } from "../lib/rooms";

const PORT = Number(process.env.PORT ?? 8000);
const HOST = process.env.HOST ?? "0.0.0.0";
const MCP_ONLY = process.env.TRIVIA_BANK_MCP_ONLY === "1";

createServer(async (incoming, outgoing) => {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const url = new URL(incoming.url ?? "/", `http://${incoming.headers.host}`);
  const request = new Request(url, {
    method: incoming.method,
    headers: incoming.headers as Record<string, string>,
    body: ["GET", "HEAD"].includes(incoming.method ?? "")
      ? undefined
      : Buffer.concat(chunks),
  });
  let response: Response;
  if (url.pathname === "/mcp" && request.method === "POST")
    response = await serve(request);
  else if (url.pathname === "/mcp" && request.method === "DELETE")
    response = close(request);
  else if (!MCP_ONLY && url.pathname === "/rooms" && request.method === "GET")
    response = Response.json(
      roomState(
        url.searchParams.get("owner") ?? process.env.TRIVIA_DEV_OWNER ?? "",
      ),
    );
  else if (url.pathname === "/health") response = new Response("ok");
  else response = new Response(null, { status: 404 });
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, HOST, () => console.log(`trivia bank on ${HOST}:${PORT}`));
