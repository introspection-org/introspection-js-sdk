/** The agent proposes a trip; the traveller's manager approves it once. */
import { proposeMission } from "@/lib/acme/person-server";
import { respond } from "@/lib/aauth";

export async function POST(request: Request) {
  return respond(() => proposeMission(request));
}
