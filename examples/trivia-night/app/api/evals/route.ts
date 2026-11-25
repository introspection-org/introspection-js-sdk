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
  advanceRun,
  agentKey,
  latestRun,
  platformClient,
  resolveTarget,
  startRun,
} from "@/lib/platform-runner";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** What the panel shows: whether a key is set, the target and the latest run. Never the key. */
export async function GET(request: Request) {
  const auth = await requireSession(request);
  if ("error" in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  const key = agentKey();
  let target = null;
  let target_error = null;
  let latest: string | null = null;
  let active: string | null = null;
  try {
    const client = platformClient();
    target = await resolveTarget(client);
    latest = await latestRun(client);
    if (latest) {
      const view = await advanceRun(client, latest);
      active = view && !view.finished ? latest : null;
    }
  } catch (error) {
    target_error = (error as Error).message;
  }
  return NextResponse.json({
    configured: "token" in key,
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
    latest,
    active,
  });
}

/** Starts a run: creates its first nights and returns; the page's polls of the run start the rest. */
export async function POST(request: Request) {
  const auth = await requireSession(request);
  if ("error" in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  const key = agentKey();
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
  const venues = Math.min(
    Math.max(Math.trunc(Number(body.venues ?? 3)) || 1, 1),
    MAX_VENUES_BY_PUBS[pubs],
  );
  try {
    return NextResponse.json(
      await startRun(
        platformClient(),
        venues,
        auth.session.member_id,
        teams,
        pubs,
      ),
    );
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 409 },
    );
  }
}
