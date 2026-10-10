import { snapshot } from "@/lib/demo/run";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(snapshot());
}
