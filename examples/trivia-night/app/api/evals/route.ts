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
  NoRuntime,
  advanceRun,
  latestRun,
  memberClient,
  resolveTarget,
  startRun,
} from "@/lib/platform-runner";
import { RUN_SCOPES, missingScopes, requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** What the panel shows: the member's target, whether they can run, and the latest run. */
export async function GET(request: Request) {
  const auth = requireSession(request);
  if ("error" in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { session } = auth;
  const missing = missingScopes(session, RUN_SCOPES);
  let target = null;
  let target_error = null;
  let no_runtime = false;
  let latest: string | null = null;
  let active: string | null = null;
  try {
    const client = memberClient(session);
    target = await resolveTarget(client, session.project_id);
    latest = await latestRun(client);
    if (latest) {
      const view = await advanceRun(client, latest, missing.length === 0);
      active = view && !view.finished ? latest : null;
    }
  } catch (error) {
    no_runtime = error instanceof NoRuntime;
    target_error = no_runtime ? null : (error as Error).message;
  }
  return NextResponse.json({
    missing_scopes: missing,
    no_runtime,
    max_venues: MAX_VENUES,
    max_venues_by_pubs: MAX_VENUES_BY_PUBS,
    team_sizes: TEAM_SIZES,
    default_teams: DEFAULT_TEAMS,
    cost_per_trial: COST_PER_TRIAL,
    trials_per_venue: TRIALS_PER_VENUE,
    target,
    target_error,
    latest,
    active,
  });
}

/** Starts a run as the member: creates its first nights and returns; the page's polls start the rest. */
export async function POST(request: Request) {
  const auth = requireSession(request);
  if ("error" in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { session } = auth;
  const missing = missingScopes(session, RUN_SCOPES);
  if (missing.length)
    return NextResponse.json(
      {
        error: `only an organization owner or admin can run the evals: your sign-in lacks ${missing.join(", ")}`,
      },
      { status: 403 },
    );
  const body = (await request.json().catch(() => ({}))) as {
    venues?: number;
    teams?: unknown;
    pubs?: unknown;
    token?: unknown;
  };
  if (
    typeof body.token !== "string" ||
    !/^[A-Za-z0-9-]{8,64}$/.test(body.token)
  )
    return NextResponse.json(
      { error: "token must name this click" },
      { status: 400 },
    );
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
      await startRun(memberClient(session), {
        venues,
        startedBy: session.member_id,
        project: session.project_id,
        token: body.token,
        teams,
        pubs,
      }),
    );
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 409 },
    );
  }
}
