import { respond } from "@/lib/aauth";
import { cancel } from "@/lib/booking";
import { recorded } from "@/lib/demo/wire";

export async function POST(request: Request) {
  return recorded("Booking provider", request, () =>
    respond(() => cancel(request)),
  );
}
