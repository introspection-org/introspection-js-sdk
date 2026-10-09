/** The approver's answer from Acme's page, proven by the code Acme emailed. */
import { decide } from "@/lib/acme/person-server";
import { AAuthError, respond } from "@/lib/aauth";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return respond(async () => {
    const body = await request.json().catch(() => ({}));
    const verdict = body.verdict;
    if (
      typeof body.code !== "string" ||
      (verdict !== "approve" && verdict !== "decline")
    )
      throw new AAuthError(
        400,
        "invalid_request",
        "a code and a verdict of approve or decline are required",
      );
    const budget =
      body.budget == null ? undefined : Math.round(Number(body.budget) * 100);
    return Response.json(await decide(id, body.code, verdict, budget));
  });
}
