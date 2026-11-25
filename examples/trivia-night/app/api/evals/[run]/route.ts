import { NextResponse } from "next/server";

import { advanceRun, memberClient } from "@/lib/platform-runner";
import { RUN_SCOPES, missingScopes, requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Moves the run on, as the member, and says where each trial stands; a member who cannot run only reads it. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ run: string }> },
) {
  const auth = requireSession(request);
  if ("error" in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { run } = await params;
  if (!/^r\d+$/.test(run))
    return NextResponse.json({ error: "no such run" }, { status: 404 });
  try {
    const view = await advanceRun(
      memberClient(auth.session),
      run,
      missingScopes(auth.session, RUN_SCOPES).length === 0,
    );
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
