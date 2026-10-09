import { reservations } from "@/lib/booking";
import { handle } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => ({ reservations }));
}
