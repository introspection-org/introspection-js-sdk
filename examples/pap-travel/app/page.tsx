import { redirect } from "next/navigation";

import { ATLAS_URL } from "@/lib/origins";

/** Reached only without a host rewrite, such as on localhost:3500. */
export default function Page() {
  redirect(ATLAS_URL);
}
