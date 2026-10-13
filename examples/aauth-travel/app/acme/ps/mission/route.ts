/** The agent proposes a trip; the traveller's manager approves it once. */
import { handle } from "@/lib/acme/person-server";
import { recorded } from "@/lib/demo/wire";

export async function POST(request: Request) {
  return recorded("Acme", request, () => handle(request, "/ps/mission"));
}
