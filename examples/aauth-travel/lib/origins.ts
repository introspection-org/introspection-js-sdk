/**
 * Where each party in the demo lives. One Next.js process serves all of them,
 * but each is its own AAuth server with its own identifier, and an identifier
 * is `https://host` with no port or path. `pnpm dev` gives each a public https
 * URL through a Cloudflare tunnel, all served by this one process.
 */
const trim = (url: string) => url.replace(/\/+$/, "");

/** The walkthrough. */
export const APP_URL = trim(
  process.env.APP_URL ?? "https://flightsector.localhost",
);

/** Flight Sector's booking provider, an AAuth resource. */
export const BOOKING_ISSUER = trim(
  process.env.BOOKING_ISSUER ?? "https://booking.flightsector.localhost",
);

/** A stand-in for Browserbase's hosted MCP, for flight searches without an account. */
export const BROWSERBASE_MCP_URL = trim(
  process.env.BROWSERBASE_MCP_URL ??
    "https://browserbase.flightsector.localhost",
);

/** Acme's Person Server. */
export const PERSON_SERVER_URL = trim(
  process.env.ACME_PERSON_SERVER_URL ?? "https://ps.acme.localhost",
);

/**
 * Which Person Server speaks for Acme's people: `acme`, Acme's own (above), or
 * `hosted`, Introspection's hosted one, with Acme deciding approvals through
 * its project's `/v1/approvals`.
 */
export const PERSON_SERVER_MODE: "acme" | "hosted" =
  process.env.PERSON_SERVER === "hosted" ? "hosted" : "acme";

/** Introspection's hosted Person Server, when Acme uses it. */
export const HOSTED_PERSON_SERVER_URL = trim(
  process.env.HOSTED_PERSON_SERVER_URL ??
    (PERSON_SERVER_MODE === "hosted"
      ? "https://ps.introspection.localhost"
      : ""),
);

/**
 * Where Acme's approval page is: Acme's own Person Server host when Acme runs
 * one, and this app's `/acme` otherwise, since a hosted Person Server leaves
 * Acme only its approval page to serve.
 */
export const ACME_APPROVAL_URL = trim(
  process.env.ACME_APPROVAL_URL ??
    (PERSON_SERVER_MODE === "hosted" ? `${APP_URL}/acme` : PERSON_SERVER_URL),
);

/** Agent providers whose agents may act here: the platform's control plane, by default. */
export const AGENT_PROVIDERS = (
  process.env.TRUSTED_AGENT_PROVIDERS ?? "https://cp.introspection.localhost"
)
  .split(",")
  .map((url) => trim(url.trim()))
  .filter(Boolean);
