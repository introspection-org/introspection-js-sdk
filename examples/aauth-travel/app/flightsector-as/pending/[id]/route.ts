/** A Person Server polls a request Flight Sector's policy is waiting on. */
import { recorded } from "@/lib/demo/wire";
import { handle } from "@/lib/flightsector-as";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return recorded("Flight Sector AS", request, () =>
    handle(request, `/pending/${encodeURIComponent(id)}`),
  );
}
