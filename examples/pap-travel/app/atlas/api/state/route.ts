import { snapshot } from "@/lib/atlas/demo";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(snapshot());
}
