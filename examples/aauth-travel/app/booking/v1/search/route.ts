import { search } from "@/lib/booking";
import { handle, readJson } from "@/lib/http";

export async function POST(request: Request) {
  return handle(async () => search(await readJson(request)));
}
