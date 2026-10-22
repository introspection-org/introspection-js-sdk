/**
 * The server side of a web chat: a broker route that mints a short-lived
 * runner session for the signed-in user, and the federated variant that
 * exchanges the user's own IdP token instead of using a service account.
 *
 * Both are Web-standard route handlers. The browser side is
 * `examples/browser/web-chat.ts`.
 *
 * Not run in the examples workflow: it needs service-account credentials the
 * job has no secret for.
 *
 * Run with (calls the broker route once):
 *   INTROSPECTION_SERVICE_ACCOUNT_CLIENT_ID=...
 *   INTROSPECTION_SERVICE_ACCOUNT_CLIENT_SECRET=...
 *   INTROSPECTION_PROJECT=<project id>
 *   node --import tsx patterns/web-chat.ts
 *
 * Optional env:
 *   INTROSPECTION_BASE_API_URL  - CP API host
 */

// #region docs:patterns/web-chat/broker-route
import { IntrospectionClient } from "@introspection-sdk/introspection-node";

// Your app's code: your session check.
async function requireSignedInUser(req: Request) {
  if (!req.headers.get("cookie")) throw new Error("not signed in");
  return { id: "user-4821" };
}

export async function POST(req: Request) {
  const user = await requireSignedInUser(req); // your auth and rate limit
  // Service-account tokens last 60 minutes and never refresh: cache below that.
  const cp = await IntrospectionClient.fromServiceAccount({
    clientId: process.env.INTROSPECTION_SERVICE_ACCOUNT_CLIENT_ID!,
    clientSecret: process.env.INTROSPECTION_SERVICE_ACCOUNT_CLIENT_SECRET!,
    project: process.env.INTROSPECTION_PROJECT!,
  });
  const runtime = await cp.runtimes.resolve("support-agent");
  const session = await cp.runtimes.openRunner(runtime.id, { identity: { user_id: user.id } });
  return Response.json(
    { token: session.session_token, runtimeId: runtime.id, dpUrl: session.deployment.endpoint },
    { headers: { "Cache-Control": "no-store" } },
  );
}
// #endregion docs:patterns/web-chat/broker-route

// #region docs:patterns/web-chat/federated-broker
import { tokenExchange } from "@introspection-sdk/introspection-node";

export async function federatedSession(idToken: string, runtimeId: string) {
  const { access_token, dp_url } = await tokenExchange({
    subjectToken: idToken,
    clientId: process.env.INTROSPECTION_FEDERATED_CLIENT_ID!,
    project: process.env.INTROSPECTION_PROJECT!,
  });
  return Response.json({ token: access_token, runtimeId, dpUrl: dp_url });
}
// #endregion docs:patterns/web-chat/federated-broker

for (const name of [
  "INTROSPECTION_SERVICE_ACCOUNT_CLIENT_ID",
  "INTROSPECTION_SERVICE_ACCOUNT_CLIENT_SECRET",
  "INTROSPECTION_PROJECT",
]) {
  if (!process.env[name]) throw new Error(`Set ${name}.`);
}
const res = await POST(
  new Request("http://localhost/api/introspection/session", {
    method: "POST",
    headers: { cookie: "session=demo" },
  }),
);
const body = (await res.json()) as { runtimeId: string; dpUrl: string };
console.log(`session for runtime ${body.runtimeId} on ${body.dpUrl}`);
