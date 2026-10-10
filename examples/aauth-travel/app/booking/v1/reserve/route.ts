import { respond } from "@/lib/aauth";
import { reserve } from "@/lib/booking";
import { recorded } from "@/lib/demo/wire";

export async function POST(request: Request) {
  return recorded("Booking provider", request, () =>
    respond(() => reserve(request)),
  );
}
