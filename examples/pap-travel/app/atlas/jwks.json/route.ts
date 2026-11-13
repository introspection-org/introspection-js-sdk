/** The key that signs Atlas's client assertions and delegations. Delegated keys, which sign Session JWTs, are never published. */
import { jwks } from "@/lib/atlas/identity";

export async function GET() {
  return Response.json(await jwks());
}
