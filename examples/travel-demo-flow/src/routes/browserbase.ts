/** A stand-in for Browserbase's hosted MCP: the handlers each example's `app/browserbase/mcp` route exports. */
import { close, serve } from "../browserbase";
import { recorded } from "../demo/wire";

export async function mcpPOST(request: Request) {
  return recorded("Browserbase", request, () => serve(request));
}

export async function mcpDELETE(request: Request) {
  return close(request);
}

// Streamable HTTP lets a server refuse the standalone event stream.
export async function mcpGET() {
  return new Response(null, {
    status: 405,
    headers: { allow: "POST, DELETE" },
  });
}
