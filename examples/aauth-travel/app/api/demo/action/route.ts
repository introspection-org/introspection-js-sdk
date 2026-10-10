/** The demo page's buttons: Sam sends a prompt, or a person answers one of Acme's emails. */
import { decide, reset, snapshot, start } from "@/lib/demo/run";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    email?: number;
    verdict?: "approve" | "decline";
    budget?: number;
    prompt?: string;
  };
  if (body.action === "start") await start(String(body.prompt ?? ""));
  else if (body.action === "decide")
    await decide(Number(body.email), body.verdict ?? "approve", body.budget);
  else if (body.action === "reset") reset();
  else return Response.json({ error: "unknown action" }, { status: 400 });
  return Response.json(snapshot());
}
