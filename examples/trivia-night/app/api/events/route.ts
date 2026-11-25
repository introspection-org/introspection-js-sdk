import { NextResponse } from "next/server";

import { since } from "@/lib/events";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const auth = await requireSession(request);
  if ("error" in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  const after = Number(new URL(request.url).searchParams.get("after") ?? 0);
  return NextResponse.json({
    events: since(Number.isFinite(after) ? after : 0),
  });
}
