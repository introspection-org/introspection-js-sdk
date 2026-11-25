import { NextResponse } from "next/server";

import {
  COST_PER_TRIAL,
  DEFAULT_TEAMS,
  MAX_VENUES,
  MAX_VENUES_BY_PUBS,
  TEAM_SIZES,
  TRIALS_PER_VENUE,
  isPubs,
  isTeamSize,
} from "@/lib/platform-evals";

import {
  KEY_HOW_TO,
  activeRun,
  apiBaseUrl,
  keyFile,
  resolveTarget,
  startRun,
} from "@/lib/platform-runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** What the panel shows: whether a key is set, and the target. Never the key. */
export async function GET() {
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
    max_venues: MAX_VENUES,
    max_venues_by_pubs: MAX_VENUES_BY_PUBS,
    team_sizes: TEAM_SIZES,
    default_teams: DEFAULT_TEAMS,
    cost_per_trial: COST_PER_TRIAL,
    trials_per_venue: TRIALS_PER_VENUE,
    missing: "missing" in key ? key.missing : null,
    how_to: KEY_HOW_TO,
    target,
    target_error,
    active: activeRun(),
  });
}

export async function POST(request: Request) {
  const key = keyFile();
  if ("missing" in key)
    return NextResponse.json(
      { error: key.missing, how_to: KEY_HOW_TO },
      { status: 403 },
    );
  const body = (await request.json().catch(() => ({}))) as {
    venues?: number;
    teams?: unknown;
    pubs?: unknown;
  };
  const pubs = body.pubs ?? "development";
  if (!isPubs(pubs))
    return NextResponse.json(
      { error: "pubs must be development or heldout" },
      { status: 400 },
    );
  const teams = body.teams ?? DEFAULT_TEAMS;
  if (!isTeamSize(teams))
    return NextResponse.json(
      { error: `teams must be one of ${TEAM_SIZES.join(", ")}` },
      { status: 400 },
    );
  try {
    return NextResponse.json(
      await startRun(Number(body.venues ?? 3), teams, pubs),
    );
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 409 },
    );
  }
}
