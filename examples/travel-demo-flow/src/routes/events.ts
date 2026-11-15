/** What Flight Sector's services saw, for the walkthrough to light up each step. */
import { NextResponse } from "next/server";

import { since } from "../events";

export async function eventsGET(request: Request) {
  const after = Number(new URL(request.url).searchParams.get("after") ?? 0);
  return NextResponse.json({
    events: since(Number.isFinite(after) ? after : 0),
  });
}
