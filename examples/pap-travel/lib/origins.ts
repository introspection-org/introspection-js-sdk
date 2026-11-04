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

const CONFIGURED = new Set(
  [COMPANY_URL, ATLAS_URL].map((url) => new URL(url).hostname),
);

const LOCAL =
  /^(localhost|.*\.localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[.*\])$/i;

/**
 * Checks a URL the other party gave before connecting to it (spec 3): https
 * only, and no loopback, private or link-local host unless it is one of this
 * demo's own, configured on purpose. It reads the name, not the DNS answer.
 */
export function reachable(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error(`${url} is not https`);
  if (LOCAL.test(parsed.hostname) && !CONFIGURED.has(parsed.hostname))
    throw new Error(`${parsed.hostname} is a local address`);
  return parsed;
}
