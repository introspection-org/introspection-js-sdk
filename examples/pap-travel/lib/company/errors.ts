import "server-only";

/**
 * An error Flight Sector answers with. With a `challenge` it is a token error
 * and goes in `WWW-Authenticate` (spec 7); otherwise it is a JSON body with
 * `error`, as OAuth, Session and conversation errors are (spec 5.3, 8.13).
 */
export class PoppyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    readonly challenge?: string,
  ) {
    super(message);
  }
}

/** A Bearer challenge: no error code when signed out, as RFC 6750 §3.1 describes. */
export function challenge(scope: string, error?: string) {
  return `Bearer ${error ? `error="${error}", ` : ""}scope="${scope}"`;
}

/** Run a handler; a PoppyError becomes its response. */
export async function respond(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof PoppyError)) {
      console.error(err);
      return Response.json({ error: "server_error" }, { status: 500 });
    }
    const headers: Record<string, string> = { "Cache-Control": "no-store" };
    if (err.challenge) headers["WWW-Authenticate"] = err.challenge;
    if (!err.code) return new Response(null, { status: err.status, headers });
    return Response.json(
      { error: err.code, error_description: err.message },
      { status: err.status, headers },
    );
  }
}
