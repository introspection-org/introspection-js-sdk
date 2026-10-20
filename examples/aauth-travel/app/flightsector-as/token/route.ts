/** A Person Server redeems a resource token here, signed with its own key. */
import { recorded } from "@/lib/demo/wire";
import { handle } from "@/lib/flightsector-as";

export async function POST(request: Request) {
  return recorded("Flight Sector AS", request, () => handle(request, "/token"));
}
