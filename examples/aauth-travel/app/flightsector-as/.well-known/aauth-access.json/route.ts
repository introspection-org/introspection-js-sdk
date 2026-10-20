import { accessServer } from "@/lib/flightsector-as";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json((await accessServer()).metadata());
}
