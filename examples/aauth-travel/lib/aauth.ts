/**
 * The AAuth glue the demo's routes share. The booking provider's AAuth is
 * @introspection-sdk/aauth-resource's and Acme's Person Server is
 * @introspection-sdk/person-server's; what is here is how a route answers an
 * error, with the resource package's AAuthError so one class flows through
 * every route.
 */
import "server-only";

import { AAuthError, problem } from "@introspection-sdk/aauth-resource";

export { AAuthError, problem };

/** Run a handler, answering any AAuthError as a problem response. */
export async function respond(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof AAuthError)
      return problem(err.status, err.error, err.message, err.headers);
    console.error(err);
    return problem(500, "server_error", (err as Error).message);
  }
}

export const now = () => Math.floor(Date.now() / 1000);
