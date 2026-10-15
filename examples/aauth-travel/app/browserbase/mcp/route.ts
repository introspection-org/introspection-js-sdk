import { close, serve } from "@/lib/browserbase";
import { recorded } from "@/lib/demo/wire";

export async function POST(request: Request) {
  return recorded("Browserbase", request, () => serve(request));
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
