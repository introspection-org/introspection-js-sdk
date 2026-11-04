import { search } from "@/lib/booking";
import { handle, readJson } from "@/lib/http";
import { recorded } from "@/lib/demo/wire";

export async function POST(request: Request) {
  return recorded("Booking provider", request, () =>
    handle(async () => search(await readJson(request))),
  );
}
