import { close, conversationUrl } from "@/lib/company/conversations";
import { caller } from "@/lib/company/oauth";
import { respond } from "@/lib/company/respond";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return respond(async () =>
    close(await caller(request, conversationUrl(id, "/close")), id),
  );
}
