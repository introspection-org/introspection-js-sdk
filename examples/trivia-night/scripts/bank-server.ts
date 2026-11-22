/**
 * The bank alone, as a plain HTTP server, for an eval's sidecar: the MCP
 * server at /mcp and the rooms API at /rooms. With no platform in front of it
 * a trial carries no end-user token, so TRIVIA_DEV_OWNER names the one venue
 * every call is for.
 */
import { createServer } from "node:http";

import { close, serve } from "../lib/mcp";
import { roomState } from "../lib/rooms";

const PORT = Number(process.env.PORT ?? 8000);

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
  else if (url.pathname === "/rooms" && request.method === "GET")
    response = Response.json(
      roomState(
        url.searchParams.get("owner") ?? process.env.TRIVIA_DEV_OWNER ?? "",
      ),
    );
  else if (url.pathname === "/health") response = new Response("ok");
  else response = new Response(null, { status: 404 });
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, "0.0.0.0", () => console.log(`trivia bank on :${PORT}`));
