import { conversationUrl, send } from "@/lib/company/conversations";
import { caller } from "@/lib/company/oauth";
import { respond } from "@/lib/company/respond";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return respond(async () => {
    const who = await caller(request, conversationUrl(id, "/messages"));
    return send(who, id, await request.json(), new URL(request.url));
  });
}
