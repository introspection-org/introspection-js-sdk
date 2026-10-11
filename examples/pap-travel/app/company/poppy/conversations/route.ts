/** Start a conversation with Flight Sector's agent (spec §7.3). */
import { conversationUrl, start } from "@/lib/company/conversations";
import { caller } from "@/lib/company/oauth";
import { respond } from "@/lib/company/respond";

export async function POST(request: Request) {
  return respond(async () => {
    const who = await caller(request, conversationUrl());
    return start(who, await request.json(), new URL(request.url));
  });
}
