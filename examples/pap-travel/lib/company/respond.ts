import "server-only";

import { OAuthError } from "./oauth";

/** Run a handler; an OAuthError becomes its JSON error, with `WWW-Authenticate` on token errors. */
export async function respond(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof OAuthError)) {
      console.error(err);
      return Response.json({ error: "server_error" }, { status: 500 });
    }
    const headers: Record<string, string> = {};
    if (
      err.status === 401 ||
      err.code === "sign_in_required" ||
      err.code === "insufficient_scope"
    )
      headers["WWW-Authenticate"] =
        `DPoP error="${err.code}"` +
        (err.scope ? `, scope="${err.scope}"` : "");
    return Response.json(
      { error: err.code, error_description: err.message },
      {
        status: err.status,
        headers: { "Cache-Control": "no-store", ...headers },
      },
    );
  }
}
