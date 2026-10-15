/** The agent polls a pending approval here, with a signed GET. */
import { handle } from "@/lib/acme/person-server";
import { recorded } from "@/lib/demo/wire";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return recorded("Acme", request, () => handle(request, `/ps/pending/${id}`));
}
