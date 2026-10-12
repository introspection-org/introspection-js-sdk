/** Where Flight Sector sends Sam's browser back after Direct Sign-In. */
import { signedIn } from "@/lib/atlas/demo";
import { ATLAS_URL } from "@/lib/origins";

export async function GET(request: Request) {
  await signedIn(new URL(request.url).searchParams);
  return Response.redirect(`${ATLAS_URL}/`, 303);
}
