/** A resource token in, an auth token (or a pending approval) out. */
import { authToken } from "@/lib/acme/person-server";
import { respond } from "@/lib/aauth";
import { recorded } from "@/lib/demo/wire";

export async function POST(request: Request) {
  return recorded("Acme", request, () => respond(() => authToken(request)));
}
