/** Sam's answer on the consent page; the browser goes back to Atlas with a code or a refusal. */
import { decide } from "@/lib/company/oauth";
import { respond } from "@/lib/company/respond";

export async function POST(request: Request) {
  return respond(async () => {
    const form = await request.formData();
    const query = new URLSearchParams(String(form.get("query") ?? ""));
    const approved =
      form.get("decision") === "approve"
        ? form.getAll("scope").map(String)
        : null;
    return Response.redirect(await decide(query, approved), 303);
  });
}
