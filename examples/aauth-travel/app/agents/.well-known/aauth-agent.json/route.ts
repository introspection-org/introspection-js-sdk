/** The demo page's Agent Provider metadata. */
import { metadata } from "@/lib/demo/agent-provider";

export function GET() {
  return Response.json(metadata());
}
