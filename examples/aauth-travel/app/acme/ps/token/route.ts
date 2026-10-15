/** A resource token in, an auth token (or a pending approval) out. */
import { handle } from "@/lib/acme/person-server";
import { recorded } from "@/lib/demo/wire";

export async function POST(request: Request) {
  return recorded("Acme", request, () => handle(request, "/ps/token"));
}
