import { NextResponse } from "next/server";

import { bookingSigner } from "@/lib/signing";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json((await bookingSigner()).jwks);
}
