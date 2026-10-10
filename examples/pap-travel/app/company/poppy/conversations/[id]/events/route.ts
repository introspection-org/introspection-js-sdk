import { conversationUrl, events } from "@/lib/company/conversations";
import { caller } from "@/lib/company/oauth";
import { respond } from "@/lib/company/respond";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return respond(async () =>
    events(
      await caller(request, conversationUrl(id, "/events")),
      id,
      new URL(request.url),
    ),
  );
}
