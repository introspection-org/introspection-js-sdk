import { respond } from "@/lib/company/errors";
import { token } from "@/lib/company/oauth";

export async function POST(request: Request) {
  return respond(async () =>
    Response.json(await token(request), {
      headers: { "Cache-Control": "no-store" },
    }),
  );
}
