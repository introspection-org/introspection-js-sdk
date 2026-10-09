/**
 * Where each party in the demo lives. One Next.js process serves all of them
 * locally, but they are separate servers in AAuth terms, each with its own
 * issuer. Acme's Person Server needs an origin of its own because a server
 * identifier is scheme and host only (no path), so it defaults to 127.0.0.1,
 * which reaches this same process under a different host.
 */
const trim = (url: string) => url.replace(/\/+$/, "");

export const APP_URL = trim(process.env.APP_URL ?? "http://localhost:3400");

/** Flight Sector's booking provider, an AAuth resource. */
export const BOOKING_ISSUER = trim(
  process.env.BOOKING_ISSUER ?? `${APP_URL}/booking`,
);

/** Acme's Person Server. Next rewrites requests for this host to /acme/*. */
export const PERSON_SERVER_URL = trim(
  process.env.ACME_PERSON_SERVER_URL ?? "http://127.0.0.1:3400",
);
