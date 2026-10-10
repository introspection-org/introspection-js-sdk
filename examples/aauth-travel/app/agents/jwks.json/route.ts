import { jwks } from "@/lib/demo/agent-provider";

export async function GET() {
  return Response.json(await jwks());
}
