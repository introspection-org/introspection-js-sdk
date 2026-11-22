import { NextResponse } from "next/server";

import { since } from "@/lib/events";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const after = Number(new URL(request.url).searchParams.get("after") ?? 0);
  return NextResponse.json({
    events: since(Number.isFinite(after) ? after : 0),
  });
}
