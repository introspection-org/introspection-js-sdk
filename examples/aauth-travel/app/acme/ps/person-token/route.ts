/** Who the agent acts for, at one resource, under its mission. */
import { requestPersonToken } from "@/lib/acme/person-server";
import { respond } from "@/lib/aauth";
import { recorded } from "@/lib/demo/wire";

export async function POST(request: Request) {
  return recorded("Acme", request, () =>
    respond(() => requestPersonToken(request)),
  );
}
