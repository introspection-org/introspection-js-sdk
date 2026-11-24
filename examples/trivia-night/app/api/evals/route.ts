import { NextResponse } from "next/server";

import {
  KEY_HOW_TO,
  activeRun,
  apiBaseUrl,
  keyFile,
  notLocal,
  resolveTarget,
  startRun,
} from "@/lib/platform-runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** What the panel shows: whether a key is set, and the target. Never the key. */
export async function GET(request: Request) {
  const refused = notLocal(request);
  if (refused) return NextResponse.json({ error: refused }, { status: 403 });
  const key = keyFile();
  let target = null;
  let target_error = null;
  try {
    target = await resolveTarget({
      ...process.env,
      INTROSPECTION_API_BASE_URL: apiBaseUrl(),
    });
  } catch (error) {
    target_error = (error as Error).message;
  }
  return NextResponse.json({
    configured: "file" in key,
    missing: "missing" in key ? key.missing : null,
    how_to: KEY_HOW_TO,
    target,
    target_error,
    active: activeRun(),
  });
}

export async function POST(request: Request) {
  const refused = notLocal(request);
  if (refused) return NextResponse.json({ error: refused }, { status: 403 });
  const key = keyFile();
  if ("missing" in key)
    return NextResponse.json(
      { error: key.missing, how_to: KEY_HOW_TO },
      { status: 403 },
    );
  const body = (await request.json().catch(() => ({}))) as { venues?: number };
  try {
    return NextResponse.json(await startRun(Number(body.venues ?? 3)));
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 409 },
    );
  }
}
