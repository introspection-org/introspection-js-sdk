/** The agent proposes a trip; the traveller's manager approves it once. */
import { proposeMission } from "@/lib/acme/person-server";
import { respond } from "@/lib/aauth";
import { recorded } from "@/lib/demo/wire";

export async function POST(request: Request) {
  return recorded("Acme", request, () =>
    respond(() => proposeMission(request)),
  );
}
