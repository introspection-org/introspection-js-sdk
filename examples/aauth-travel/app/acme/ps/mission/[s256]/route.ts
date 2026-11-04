/** An update to the trip, or the agent's proposal that it is done. */
import { handle } from "@/lib/acme/person-server";
import { recorded } from "@/lib/demo/wire";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ s256: string }> },
) {
  const { s256 } = await params;
  return recorded("Acme", request, () =>
    handle(request, `/ps/mission/${s256}`),
  );
}
