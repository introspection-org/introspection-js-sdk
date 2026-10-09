/** Who the agent acts for, at one resource, under its mission. */
import { requestPersonToken } from "@/lib/acme/person-server";
import { respond } from "@/lib/aauth";

export async function POST(request: Request) {
  return respond(() => requestPersonToken(request));
}
