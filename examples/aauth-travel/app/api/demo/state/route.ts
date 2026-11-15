import { start } from "introspection-example-travel-demo-flow/acme/hosted";
import { snapshot } from "introspection-example-travel-demo-flow/demo/run";
import { PERSON_SERVER_MODE } from "introspection-example-travel-demo-flow/origins";

export const dynamic = "force-dynamic";

export function GET() {
  // Also started at boot; this covers a server whose module was reloaded since.
  if (PERSON_SERVER_MODE === "hosted") start();
  return Response.json(snapshot());
}
