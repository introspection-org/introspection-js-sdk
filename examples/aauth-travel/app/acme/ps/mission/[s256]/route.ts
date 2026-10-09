/** An update to the trip, or the agent's proposal that it is done. */
import { missionAction } from "@/lib/acme/person-server";
import { respond } from "@/lib/aauth";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ s256: string }> },
) {
  const { s256 } = await params;
  return respond(() => missionAction(request, s256));
}
