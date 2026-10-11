/** The public key Atlas signs its assertions with. Its DPoP keys are never published. */
import { jwks } from "@/lib/atlas/client";

export async function GET() {
  return Response.json(await jwks());
}
