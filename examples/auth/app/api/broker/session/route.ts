/**
 * Confidential broker — mints an Introspection token server-side, keeping the
 * client secret (service_account) and the end user's brokered-IdP id_token
 * (federated) off the browser. Two modes:
 *
 *  - `service_account` — client_credentials; mints a machine token.
 *  - `federated`       — RFC 8693 token-exchange; trades the customer's OWN
 *                        IdP id_token (Okta / Supabase / Auth0) for a
 *                        project-scoped DP token for a `customer` member.
 *
 * The `spa` mode does NOT use this route — it's public and runs entirely
 * client-side (hosted login, authorization_code + PKCE). See app/page.tsx.
 *
 * Both modes return the access_token to the caller, which completes the shared
 * tail (DP `/v1/oauth/exchange` → intro_dp_session cookie → task) in the
 * browser, exactly like the spa flow.
 */
import { NextResponse } from "next/server";

import {
  controlPlaneUrl,
  federatedClientId,
  projectId,
  serviceAccountCreds,
} from "@/lib/config";
import { tokenExchange } from "@/lib/intro";

interface BrokerRequest {
  mode?: "service_account" | "federated";
  /** Required for `federated`: the end user's brokered-IdP id_token. */
  subject_token?: string;
}

export async function POST(request: Request) {
  let body: BrokerRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const project = projectId();

  if (body.mode === "service_account") {
    const { clientId, clientSecret } = serviceAccountCreds();
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      project_id: project,
    });

    const res = await fetch(`${controlPlaneUrl()}/v1/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      cache: "no-store",
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error(
        `broker ${body.mode} failed (${res.status}): ${detail.slice(0, 500)}`,
      );
      return NextResponse.json(
        { error: "Could not mint a token" },
        { status: 502 },
      );
    }

    const token = (await res.json()) as { access_token: string };
    return NextResponse.json({ token: token.access_token, projectId: project });
  }

  if (body.mode === "federated") {
    if (!body.subject_token) {
      return NextResponse.json(
        { error: "Missing subject_token (the brokered-IdP id_token)" },
        { status: 400 },
      );
    }
    try {
      const token = await tokenExchange({
        cpUrl: controlPlaneUrl(),
        clientId: federatedClientId(),
        projectId: project,
        subjectToken: body.subject_token,
      });
      return NextResponse.json({ token, projectId: project });
    } catch (err) {
      // Never echo the id_token or CP detail to the browser.
      console.error(
        `broker federated failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return NextResponse.json(
        { error: "Could not exchange the id_token" },
        { status: 502 },
      );
    }
  }

  return NextResponse.json({ error: "Unknown mode" }, { status: 400 });
}
