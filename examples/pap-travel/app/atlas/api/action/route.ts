/** The page's buttons: Sam's side of the chat. */
import { ask, choose, disconnect, reset, snapshot } from "@/lib/atlas/demo";

export async function POST(request: Request) {
  const { action, option } = (await request.json().catch(() => ({}))) as {
    action?: string;
    option?: string;
  };
  if (action === "ask") await ask();
  else if (action === "choose") await choose(String(option));
  else if (action === "disconnect") await disconnect();
  else if (action === "reset") reset();
  else return Response.json({ error: "unknown action" }, { status: 400 });
  return Response.json(snapshot());
}
