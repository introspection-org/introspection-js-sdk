import { close, serve } from "@/lib/mcp";

export async function POST(request: Request) {
  return serve(request);
}

export async function DELETE(request: Request) {
  return close(request);
}

// Streamable HTTP lets a server refuse the standalone event stream.
export async function GET() {
  return new Response(null, {
    status: 405,
    headers: { allow: "POST, DELETE" },
  });
}
