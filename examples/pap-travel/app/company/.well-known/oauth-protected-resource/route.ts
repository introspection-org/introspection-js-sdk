/** The domain's protected resource metadata: where its issuer is (RFC 9728, spec 3.2). */
import { protectedResource } from "@/lib/company/oauth";

export function GET() {
  return Response.json(protectedResource());
}
