import { start } from "@/lib/acme/hosted";
import { snapshot } from "@/lib/demo/run";
import { PERSON_SERVER_MODE } from "@/lib/origins";

export const dynamic = "force-dynamic";

export function GET() {
  // Also started at boot; this covers a server whose module was reloaded since.
  if (PERSON_SERVER_MODE === "hosted") start();
  return Response.json(snapshot());
}
