import { NextResponse } from "next/server";

import { resetRoom, roomState } from "@/lib/rooms";
import { loadState, saveState } from "@/lib/state";

export const dynamic = "force-dynamic";

// For the local room driver only: it reads any venue's state by name.
const enabled = () => process.env.TRIVIA_ROOMS_API === "1";

export async function GET(request: Request) {
  if (!enabled()) return new Response(null, { status: 404 });
  loadState();
  const owner = new URL(request.url).searchParams.get("owner");
  if (!owner)
    return NextResponse.json({ error: "owner is required" }, { status: 400 });
  return NextResponse.json(roomState(owner));
}

export async function DELETE(request: Request) {
  if (!enabled()) return new Response(null, { status: 404 });
  loadState();
  const owner = new URL(request.url).searchParams.get("owner");
  if (!owner)
    return NextResponse.json({ error: "owner is required" }, { status: 400 });
  resetRoom(owner);
  saveState();
  return new Response(null, { status: 204 });
}
