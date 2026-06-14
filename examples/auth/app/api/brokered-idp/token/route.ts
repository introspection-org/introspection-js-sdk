import { NextResponse } from "next/server";

import { brokeredAudienceClientId, zitadelIssuerUrl } from "@/lib/config";

interface BrokeredTokenRequest {
  code?: string;
  code_verifier?: string;
  redirect_uri?: string;
}

export async function POST(request: Request) {
  let body: BrokeredTokenRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.code || !body.code_verifier || !body.redirect_uri) {
    return NextResponse.json(
      { error: "Missing code, code_verifier, or redirect_uri" },
      { status: 400 },
    );
  }

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: body.code,
    redirect_uri: body.redirect_uri,
    client_id: brokeredAudienceClientId(),
    code_verifier: body.code_verifier,
  });

  const res = await fetch(`${zitadelIssuerUrl()}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    cache: "no-store",
  });

  if (!res.ok) {
    const detail = await res.text();
    console.error(
      `brokered zitadel token exchange failed (${res.status}): ${detail.slice(0, 500)}`,
    );
    return NextResponse.json(
      { error: "Could not exchange the brokered authorization code" },
      { status: 502 },
    );
  }

  const token = (await res.json()) as { id_token?: string };
  if (!token.id_token) {
    return NextResponse.json(
      { error: "Zitadel token response had no id_token" },
      { status: 502 },
    );
  }

  return NextResponse.json({ id_token: token.id_token });
}
