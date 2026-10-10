import { resourceMetadata } from "@/lib/booking";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(resourceMetadata());
}
