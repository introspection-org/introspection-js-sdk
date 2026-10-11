import { revoke } from "@/lib/company/oauth";
import { respond } from "@/lib/company/respond";

export async function POST(request: Request) {
  return respond(async () => Response.json(await revoke(request)));
}
