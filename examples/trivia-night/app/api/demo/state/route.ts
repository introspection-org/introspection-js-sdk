import { NextResponse } from "next/server";

import { state } from "@/lib/demo";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(state());
}
