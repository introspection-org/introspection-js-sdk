/**
 * The page's composer and buttons: Sam's side of the chat, a person answering
 * one of Acme's emails behind it, and loading a conversation by its task.
 */
import { decide, join } from "introspection-example-travel-demo-flow/demo/run";

import { act, reset, send, snapshot } from "@/lib/atlas/demo";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    text?: string;
    email?: number;
    verdict?: "approve" | "decline";
    budget?: number;
    taskId?: string;
  };
  if (body.action === "send") await send(String(body.text ?? ""));
  else if (body.action === "reset") reset();
  else if (body.action === "decide")
    await decide(Number(body.email), body.verdict ?? "approve", body.budget);
  else if (body.action === "join") await join(String(body.taskId ?? ""));
  else await act(String(body.action));
  return Response.json(snapshot());
}
