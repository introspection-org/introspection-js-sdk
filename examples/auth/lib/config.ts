/**
 * Server-side broker configuration for the secret-bearing `service_account`
 * mode. Imported **only** from the broker route — these client secrets are
 * NEVER sent to the browser. The `spa` mode uses none of this (it's public,
 * client-side).
 */
import "server-only";

export interface BrokerCreds {
  clientId: string;
  clientSecret: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. See apps/sample-auth/.env.example.`,
    );
  }
  return value;
}

/** Confidential `service_account` Application credentials. */
export function serviceAccountCreds(): BrokerCreds {
  return {
    clientId: required("INTROSPECTION_SERVICE_ACCOUNT_CLIENT_ID"),
    clientSecret: required("INTROSPECTION_SERVICE_ACCOUNT_CLIENT_SECRET"),
  };
}

/**
 * The `federated` Application's `client_id` — the per-customer app whose
 * brokered IdP (Okta / Supabase / Auth0) the token-exchange grant trusts.
 * Public (it identifies the app, not a secret), but the broker reads it
 * server-side so the token-exchange call stays off the browser.
 */
export function federatedClientId(): string {
  return required("FEDERATED_CLIENT_ID");
}

/**
 * The public `spa` Application's `client_id` (PKCE — no secret). The browser
 * uses it for the authorize redirect; the broker uses it to exchange the
 * returned code server-side. Same value, read from the public var.
 */
export function spaClientId(): string {
  return required("NEXT_PUBLIC_INTROSPECTION_SPA_CLIENT_ID");
}

/**
 * The runtime the broker resolves to a `runtime_id` server-side (a Control
 * Plane lookup that never happens in the browser). Defaults to the shared
 * sample runtime slug.
 */
export function runtimeSlug(): string {
  return process.env.INTRO_RUNTIME ?? "customer-agent";
}

/**
 * Control Plane base URL. One var for both surfaces: the broker (server) and
 * the spa hosted-login pages (browser, which redirect to CP directly). The DP
 * URL is NOT configured here — it comes back from the CP token response.
 */
export function controlPlaneUrl(): string {
  return (
    process.env.NEXT_PUBLIC_INTROSPECTION_CP_URL ?? "http://localhost:8000"
  ).replace(/\/+$/, "");
}

/**
 * The Introspection project all modes scope tokens to. Accepts a slug or UUID.
 * The federated broker reads `INTRO_PROJECT` when set (server-only naming) and
 * otherwise falls back to the shared public project selector used by spa /
 * service_account.
 */
export function project(): string {
  return (
    process.env.INTRO_PROJECT ?? required("NEXT_PUBLIC_INTROSPECTION_PROJECT")
  );
}

export function zitadelIssuerUrl(): string {
  return (
    process.env.NEXT_PUBLIC_ZITADEL_ISSUER_URL ?? "http://localhost:8009"
  ).replace(/\/+$/, "");
}

export function brokeredAudienceClientId(): string {
  return required("NEXT_PUBLIC_BROKERED_AUDIENCE_CLIENT_ID");
}
