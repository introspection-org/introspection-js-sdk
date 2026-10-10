/**
 * Where each party lives. One Next.js process serves both, each on its own
 * https host through portless (see package.json).
 */
const trim = (url: string) => url.replace(/\/+$/, "");

/** Flight Sector: its domain, OAuth issuer and conversation API, on one host. */
export const COMPANY_URL = trim(
  process.env.COMPANY_URL ?? "https://pap.flightsector.localhost",
);

/** Atlas, Sam's personal agent, and the page that shows the demo. */
export const ATLAS_URL = trim(
  process.env.ATLAS_URL ?? "https://atlas.localhost",
);
