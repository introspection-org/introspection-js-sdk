import { personServerMetadata } from "@/lib/acme/person-server";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(personServerMetadata());
}
