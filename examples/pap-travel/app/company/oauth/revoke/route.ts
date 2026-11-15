import { respond } from "@/lib/company/errors";
import { revoke } from "@/lib/company/oauth";

export async function POST(request: Request) {
  return respond(async () => Response.json(await revoke(request)));
}
