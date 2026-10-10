/** A booking proposal, served to the Person Server it was published for. */
import { respond } from "@/lib/aauth";
import { serveProposal } from "@/lib/booking";
import { recorded } from "@/lib/demo/wire";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params;
  return recorded("Booking provider", request, () =>
    respond(() => serveProposal(request, key)),
  );
}
