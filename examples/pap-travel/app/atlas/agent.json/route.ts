/** Atlas's Client ID Metadata Document: its `client_id` is this URL (spec §4.1). */
import { clientMetadata } from "@/lib/atlas/client";

export function GET() {
  return Response.json(clientMetadata());
}
