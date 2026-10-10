/** The agent polls a pending approval here, with a signed GET. */
import { pendingState } from "@/lib/acme/person-server";
import { respond } from "@/lib/aauth";
import { recorded } from "@/lib/demo/wire";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return recorded("Acme", request, () =>
    respond(() => pendingState(request, id)),
  );
}
