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
  IntrospectionClient,
  serviceAccountToken,
} from "@introspection-sdk/introspection-node";

import {
  controlPlaneUrl,
  dataPlaneUrl,
  federatedClientId,
  projectId,
  runtimeName,
  serviceAccountCreds,
} from "@/lib/config";
import { tokenExchange } from "@/lib/intro";

/**
 * Resolve the configured runtime name to its current `runtime_id` using the
 * Node SDK and the given CP access token. The id changes whenever the runtime
 * is re-deployed, so the broker resolves it fresh on each session rather than
 * pinning it — and it stays on the server, keeping the Control Plane off the
 * browser's CORS surface.
 */
async function resolveRuntimeId(token: string): Promise<string> {
  const cp = new IntrospectionClient({
    token,
    advanced: { baseApiUrl: controlPlaneUrl() },
  });
  const runtime = await cp.runtimes.resolveByName(runtimeName());
  return runtime.id;
}

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
    try {
      // 1) Mint a machine token via the Node SDK's client_credentials helper.
      const { access_token } = await serviceAccountToken({
        clientId,
        clientSecret,
        projectId: project,
        baseApiUrl: controlPlaneUrl(),
      });
      // 2) Resolve the runtime id server-side with that same token.
      const runtimeId = await resolveRuntimeId(access_token);
      // 3) Hand the browser the token + resolved id + the DP URL to connect to.
      //    The browser talks only to the DP and is configured entirely from
      //    this response — no CP/DP env needed in the SPA.
      return NextResponse.json({
        token: access_token,
        projectId: project,
        runtimeId,
        dpUrl: dataPlaneUrl(),
      });
    } catch (err) {
      console.error(
        `broker ${body.mode} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return NextResponse.json(
        { error: "Could not mint a token" },
        { status: 502 },
      );
    }
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
