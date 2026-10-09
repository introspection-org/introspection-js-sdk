import { respond } from "@/lib/aauth";
import { reserve } from "@/lib/booking";

export async function POST(request: Request) {
  return respond(() => reserve(request));
}
