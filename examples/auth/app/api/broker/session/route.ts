/**
 * Confidential broker — establishes an Introspection session server-side and
 * hands the browser exactly what it needs: a project token plus a bounded
 * Runner. Every Introspection token POST runs here through the Node SDK, so
 * the browser never hand-rolls an OAuth call. Three modes:
 *
 *  - `service_account`    — `client_credentials`; mints a machine token.
 *  - `federated`          — RFC 8693 token-exchange of the customer's OWN IdP
 *                           id_token for a project-scoped `customer` DP token.
 *  - `authorization_code` — PKCE hosted-login: exchanges the code the spa
 *                           redirect returned (the verifier travels from the
 *                           browser, the POST happens here).
 *
 * In every mode the broker uses the deployment-audience token to mint a Runner
 * at DP `/v1/runtimes/run`. The browser uses that bearer for task execution
 * while its project-wide OAuth cookie remains independent.
 */
import { NextResponse } from "next/server";
import {
  authorizationCodeToken,
  serviceAccountToken,
  tokenExchange,
  type OAuthToken,
  type RunnerSpec,
} from "@introspection-sdk/introspection-node";

import {
  controlPlaneUrl,
  federatedClientId,
  project,
  runtime,
  serviceAccountCreds,
  spaClientId,
} from "@/lib/config";

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
  identity?: {
    user_id?: string;
    anonymous_id?: string;
    conversation_id?: string;
  };
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

async function mintRunner(
  token: OAuthToken,
  identity: BrokerRequest["identity"],
): Promise<RunnerSpec> {
  const res = await fetch(`${dpUrlOrThrow(token)}/v1/runtimes/run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      runtime: runtime(),
      scope:
        "tasks:read tasks:write files:read files:write shares:read shares:write conversations:read events:read metrics:read",
      ...(identity ? { identity } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`Runner mint failed (${res.status})`);
  }
  return (await res.json()) as RunnerSpec;
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
    const runner = await mintRunner(token, body.identity);
    return NextResponse.json({
      token: token.access_token,
      dpUrl: dpUrlOrThrow(token),
      runner,
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
