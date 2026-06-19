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
 * The runtime the broker resolves to a `runtime_id` server-side (a Control
 * Plane lookup that never happens in the browser). Defaults to the shared
 * sample runtime name.
 */
export function runtimeName(): string {
  return process.env.INTRO_RUNTIME_NAME ?? "customer-agent";
}

/**
 * Control Plane base URL (server-to-server). Prefers the server-only
 * `INTROSPECTION_CP_URL` so it can be overridden per deployment at runtime
 * (staging vs prod) — `NEXT_PUBLIC_*` vars are inlined by Next.js at build
 * time and won't change without a rebuild. Falls back to the public var, then
 * local.
 */
export function controlPlaneUrl(): string {
  return (
    process.env.INTROSPECTION_CP_URL ??
    process.env.NEXT_PUBLIC_INTROSPECTION_CP_URL ??
    "http://localhost:8000"
  ).replace(/\/+$/, "");
}

/**
 * Data Plane base URL the broker hands back to the browser (with the token +
 * runtime_id) so the SPA never has to be configured with it directly. Same
 * server-only-first precedence as {@link controlPlaneUrl}.
 */
export function dataPlaneUrl(): string {
  return (
    process.env.INTROSPECTION_DP_URL ??
    process.env.NEXT_PUBLIC_INTROSPECTION_DP_URL ??
    "http://localhost:8002"
  ).replace(/\/+$/, "");
}

/**
 * The Introspection project all modes scope tokens to. The federated broker
 * reads `INTRO_PROJECT_ID` when set (server-only naming) and otherwise falls
 * back to the shared public project id used by spa / service_account.
 */
export function projectId(): string {
  return (
    process.env.INTRO_PROJECT_ID ??
    required("NEXT_PUBLIC_INTROSPECTION_PROJECT_ID")
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
