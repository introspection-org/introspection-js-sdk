import { NextResponse } from "next/server";

import { platformClient, trialResult } from "@/lib/platform-runner";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A finished trial's result, read from its verification's files; it never changes once done. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ task: string }> },
) {
  const auth = await requireSession(request);
  if ("error" in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { task } = await params;
  if (!UUID.test(task))
    return NextResponse.json({ error: "no such trial" }, { status: 404 });
  try {
    const result = await trialResult(platformClient(), task);
    if (!result)
      return NextResponse.json({ error: "no such trial" }, { status: 404 });
    return NextResponse.json(result, {
      headers: { "cache-control": "private, max-age=3600" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 502 },
    );
  }
}
