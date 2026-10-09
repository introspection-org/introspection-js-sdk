/** A resource token in, an auth token (or a pending approval) out. */
import { authToken } from "@/lib/acme/person-server";
import { respond } from "@/lib/aauth";

export async function POST(request: Request) {
  return respond(() => authToken(request));
}
