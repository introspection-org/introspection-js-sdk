import { NextResponse } from "next/server";

import { bookingResource } from "@/lib/booking";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json((await bookingResource()).jwks());
}
