import { NextResponse } from "next/server";

import { advanceRun, platformClient } from "@/lib/platform-runner";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Moves the run on and says where each trial stands; the page polls it while the run goes. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ run: string }> },
) {
  const auth = await requireSession(request);
  if ("error" in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { run } = await params;
  if (!/^r\d+$/.test(run))
    return NextResponse.json({ error: "no such run" }, { status: 404 });
  try {
    const view = await advanceRun(platformClient(), run);
    if (!view)
      return NextResponse.json({ error: "no such run" }, { status: 404 });
    return NextResponse.json(view);
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 502 },
    );
  }
}
