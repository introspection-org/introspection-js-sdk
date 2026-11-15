/** Flight Sector's OAuth server metadata (RFC 8414), listing the domain it speaks for. */
import { serverMetadata } from "@/lib/company/oauth";

export function GET() {
  return Response.json(serverMetadata());
}
