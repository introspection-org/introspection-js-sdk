/**
 * Where each party in the demo lives. One Next.js process serves all of them,
 * but each is its own AAuth server with its own identifier, and an identifier
 * is `https://host` with no port or path. Locally, portless gives each name a
 * trusted https host on this one process (see package.json).
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

/** Acme's Person Server. */
export const PERSON_SERVER_URL = trim(
  process.env.ACME_PERSON_SERVER_URL ?? "https://ps.acme.localhost",
);

/** Agent providers whose agents may act here: the platform's control plane, by default. */
export const AGENT_PROVIDERS = (
  process.env.TRUSTED_AGENT_PROVIDERS ?? "https://cp.introspection.localhost"
)
  .split(",")
  .map((url) => trim(url.trim()))
  .filter(Boolean);
