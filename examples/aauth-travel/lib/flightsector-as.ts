/**
 * Flight Sector's own Access Server (AAuth -11 four-party), run with
 * `FLIGHTSECTOR_FEDERATED=1` on @introspection-sdk/access-server. The booking
 * provider names it as the `aud` of its resource tokens, so the traveller's
 * Person Server, having weighed the booking against the trip, asks it for the
 * auth token. Its policy is Flight Sector's: it books only for a company that
 * has a Flight Sector account, named by the person's `tenant` at their Person
 * Server.
 */
import "server-only";

import {
  type AccessServer,
  createAccessServer,
} from "@introspection-sdk/access-server";

import { record } from "./events";
import {
  agentProviders,
  BOOKING_ISSUER,
  FLIGHTSECTOR_AS_URL,
  HOSTED_PERSON_SERVER_URL,
  PERSON_SERVER_URL,
} from "./origins";

/**
 * Companies with a Flight Sector account, as `tenant@person-server`
 * (comma-separated). Default: Acme, at Acme's own Person Server.
 */
const ACCOUNTS = (
  process.env.FLIGHTSECTOR_ACCOUNTS || `acme@${PERSON_SERVER_URL}`
)
  .split(",")
  .map((account) => account.trim())
  .filter(Boolean);

const registry = globalThis as unknown as {
  __flightSectorAccessServer?: Promise<AccessServer>;
};

// #region access-server
export const accessServer = () =>
  (registry.__flightSectorAccessServer ??= createAccessServer({
    issuer: FLIGHTSECTOR_AS_URL,
    name: "Flight Sector Access Server",
    description:
      "Decides for Flight Sector's booking provider: it books for companies with a Flight Sector account.",
    resources: [BOOKING_ISSUER],
    personServers: [PERSON_SERVER_URL, HOSTED_PERSON_SERVER_URL].filter(
      Boolean,
    ),
    agentProviders: agentProviders(),
    signingKey: process.env.FLIGHTSECTOR_AS_SIGNING_KEY,
    kid: "flightsector-as-1",
    policy: ({ ps, tenant, summary }) => {
      const account = `${tenant}@${ps}`;
      if (tenant && ACCOUNTS.includes(account)) {
        record(
          "flightsector.as_allowed",
          `${account}: ${summary ?? "a booking"}`,
          {
            ps,
            tenant,
          },
        );
        return { decision: "allow" };
      }
      record(
        "flightsector.as_denied",
        `${account} has no Flight Sector account`,
        {
          ps,
          tenant,
        },
      );
      return {
        decision: "deny",
        detail: `${tenant ?? "this company"} has no Flight Sector account`,
      };
    },
  }));
// #endregion

/** Serve a request at the path the Person Server addressed (Next rewrites the AS's host under /flightsector-as). */
export async function handle(request: Request, path: string) {
  return (await accessServer()).handle(request, path);
}
