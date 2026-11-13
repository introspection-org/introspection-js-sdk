/** Start a conversation with Flight Sector's agent (spec 8.3). */
import { conversationUrl, start } from "@/lib/company/conversations";
import { respond } from "@/lib/company/errors";
import { verify } from "@/lib/company/session";

export async function POST(request: Request) {
  return respond(async () => {
    const caller = await verify(request, conversationUrl());
    const body = await request.json().catch(() => ({}));
    return start(caller, body, new URL(request.url));
  });
}
