/** Who the agent acts for, at one resource, under its mission. */
import { handle } from "@/lib/acme/person-server";
import { recorded } from "@/lib/demo/wire";

export async function POST(request: Request) {
  return recorded("Acme", request, () => handle(request, "/ps/person-token"));
}
