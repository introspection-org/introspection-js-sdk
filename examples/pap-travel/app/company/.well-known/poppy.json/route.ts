/** What a Personal Agent needs to work with Flight Sector (spec §3). */
import { poppyDocument } from "@/lib/company/oauth";

export function GET() {
  return Response.json(poppyDocument());
}
