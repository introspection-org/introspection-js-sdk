import { NextResponse } from "next/server";

import { play, restart } from "@/lib/demo";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    venue?: string;
    host?: string;
  };
  if (body.action === "restart") {
    restart();
    return NextResponse.json({ ok: true });
  }
  if (body.action !== "play")
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  try {
    return NextResponse.json(play(body.venue ?? "", body.host ?? ""));
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 400 },
    );
  }
}
