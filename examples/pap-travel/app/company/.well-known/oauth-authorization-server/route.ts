/** Flight Sector's OAuth server metadata (RFC 8414), with the domains it speaks for. */
import { serverMetadata } from "@/lib/company/oauth";

export function GET() {
  return Response.json(serverMetadata());
}
