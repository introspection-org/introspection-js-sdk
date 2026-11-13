import { conversationUrl, send } from "@/lib/company/conversations";
import { respond } from "@/lib/company/errors";
import { verify } from "@/lib/company/session";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return respond(async () => {
    const caller = await verify(request, conversationUrl(id, "/messages"));
    return send(
      caller,
      id,
      await request.json().catch(() => ({})),
      new URL(request.url),
    );
  });
}
