/** The page's buttons and composer: Sam's side of the chat. */
import { act, reset, send, snapshot } from "@/lib/atlas/demo";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    option?: string;
    text?: string;
  };
  if (body.action === "send") await send(String(body.text ?? ""));
  else if (body.action === "reset") reset();
  else await act(String(body.action), body.option);
  return Response.json(snapshot());
}
