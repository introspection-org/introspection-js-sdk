/**
 * Confidential broker — establishes an Introspection session server-side and
 * hands the browser exactly what it needs: `{ token, project, runtimeId,
 * dpUrl }`. Every Introspection token POST runs here through the Node SDK, so
 * the browser never hand-rolls an OAuth call. Three modes:
 *
 *  - `service_account`    — `client_credentials`; mints a machine token.
 *  - `federated`          — RFC 8693 token-exchange of the customer's OWN IdP
 *                           id_token for a project-scoped `customer` DP token.
 *  - `authorization_code` — PKCE hosted-login: exchanges the code the spa
 *                           redirect returned (the verifier travels from the
 *                           browser, the POST happens here).
 *
 * In every mode the broker also resolves the runtime id and reads the DP URL
 * off the CP token response, so the SPA is configured entirely from the
 * response — no CP/DP/runtime env in the browser. The browser then completes
 * the shared tail (DP `/v1/oauth/exchange` → intro_dp_session cookie → task).
 */
import { NextResponse } from "next/server";
import {
  IntrospectionClient,
  authorizationCodeToken,
  serviceAccountToken,
  tokenExchange,
  type OAuthToken,
} from "@introspection-sdk/introspection-node";

import {
  controlPlaneUrl,
  federatedClientId,
  project,
  runtime,
  serviceAccountCreds,
  spaClientId,
} from "@/lib/config";

/**
 * Resolve the configured runtime slug to its current id. Runtime resolution is
 * a Control Plane call, so it always uses the service-account (machine)
 * credential server-side — never the end-user/customer token (the member_type
 * wall keeps those off CP routes) and never the browser. The id changes when
 * the runtime is re-deployed, so it is resolved fresh on every session.
 */
async function resolveRuntimeId(): Promise<string> {
  const { clientId, clientSecret } = serviceAccountCreds();
  const { access_token } = await serviceAccountToken({
    clientId,
    clientSecret,
    project: project(),
    baseApiUrl: controlPlaneUrl(),
  });
  const cp = new IntrospectionClient({
    token: access_token,
    advanced: { baseApiUrl: controlPlaneUrl() },
  });
  return (await cp.runtimes.resolve(runtime())).id;
}

/** The CP resolves the project's DP URL onto the token response (like the CLI login). */
function dpUrlOrThrow(token: OAuthToken): string {
  if (!token.dp_url) {
    throw new Error("CP did not resolve a Data Plane URL for this project");
  }
  return token.dp_url;
}

interface BrokerRequest {
  mode?: "service_account" | "federated" | "authorization_code";
  /** `federated`: the end user's brokered-IdP id_token. */
  subject_token?: string;
  /** `authorization_code`: the values from the hosted-login redirect. */
  code?: string;
  code_verifier?: string;
  redirect_uri?: string;
}

async function mintUserToken(body: BrokerRequest): Promise<OAuthToken> {
  const projectSelector = project();
  if (body.mode === "service_account") {
    const { clientId, clientSecret } = serviceAccountCreds();
    return serviceAccountToken({
      clientId,
      clientSecret,
      project: projectSelector,
      baseApiUrl: controlPlaneUrl(),
    });
  }
  if (body.mode === "federated") {
    if (!body.subject_token) {
      throw new Error("Missing subject_token (the brokered-IdP id_token)");
    }
    return tokenExchange({
      subjectToken: body.subject_token,
      clientId: federatedClientId(),
      project: projectSelector,
      baseApiUrl: controlPlaneUrl(),
    });
  }
  if (body.mode === "authorization_code") {
    if (!body.code || !body.code_verifier || !body.redirect_uri) {
      throw new Error("Missing code / code_verifier / redirect_uri");
    }
    return authorizationCodeToken({
      code: body.code,
      clientId: spaClientId(),
      redirectUri: body.redirect_uri,
      codeVerifier: body.code_verifier,
      baseApiUrl: controlPlaneUrl(),
    });
  }
  throw new Error("Unknown mode");
}

export async function POST(request: Request) {
  let body: BrokerRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const token = await mintUserToken(body);
    const runtimeId = await resolveRuntimeId();
    return NextResponse.json({
      token: token.access_token,
      project: project(),
      runtimeId,
      dpUrl: dpUrlOrThrow(token),
    });
  } catch (err) {
    // Never echo the subject token / id_token or CP detail to the browser.
    console.error(
      `broker ${body.mode ?? "?"} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return NextResponse.json(
      { error: "Could not establish a session" },
      { status: 502 },
    );
  }
}
