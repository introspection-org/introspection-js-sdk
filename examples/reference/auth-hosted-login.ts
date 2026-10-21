/**
 * Authentication reference: hosted browser login.
 *
 * Backs the docs' Authentication page, "Hosted browser login" (region
 * `reference/authentication/hosted-login`). The region is module-level and
 * carries its import, as the docs do; the code above it supplies the
 * `code`, `redirectUri` and `codeVerifier` the snippet takes as given. The
 * code is single-use and comes from a live hosted-login redirect, so this
 * module is not run in CI. The full flow is the `auth` example app.
 *
 * Run with:
 *   INTROSPECTION_SPA_CLIENT_ID=intro_app_xxx
 *   pnpm reference-auth-hosted-login <code> <redirect-uri> <code-verifier>
 *
 * Optional env:
 *   INTROSPECTION_BASE_API_URL  - CP API host (default https://api.introspection.dev)
 */

const [code, redirectUri, codeVerifier] = process.argv.slice(2);
if (!code || !redirectUri || !codeVerifier || !process.env.INTROSPECTION_SPA_CLIENT_ID) {
  console.error(
    "usage: INTROSPECTION_SPA_CLIENT_ID=... pnpm reference-auth-hosted-login <code> <redirect-uri> <code-verifier>",
  );
  process.exit(1);
}

// #region docs:reference/authentication/hosted-login
import { authorizationCodeToken } from "@introspection-sdk/introspection-node";

// In your backend, after the hosted-login redirect.
const token = await authorizationCodeToken({
  code,                                              // from the redirect URI
  clientId: process.env.INTROSPECTION_SPA_CLIENT_ID, // public client, no secret
  redirectUri,                                       // must match the authorize call
  codeVerifier,                                      // pairs with the PKCE challenge
});
// #endregion docs:reference/authentication/hosted-login

console.log(`access token expires in ${token.expires_in}s`);
