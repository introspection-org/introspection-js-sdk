import { personServerSigner } from "@/lib/signing";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json((await personServerSigner()).jwks);
}
