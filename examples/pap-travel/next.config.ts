import type { NextConfig } from "next";

import {
  APP_URL,
  BOOKING_ISSUER,
  BROWSERBASE_MCP_URL,
  PERSON_SERVER_MODE,
  PERSON_SERVER_URL,
} from "introspection-example-travel-demo-flow/origins";

import { ATLAS_URL, COMPANY_URL } from "./lib/origins";

// Each party is its own https host, and this one process answers for each by
// rewriting its host to its routes. Atlas and Flight Sector's Poppy host are
// local (portless); the booking provider, the Browserbase mock and Acme's
// Person Server are the parties Introspection calls, on public tunnels, as in
// aauth-travel. A party on the app's own host keeps its path prefix, and the
// AAuth parties' prefixes stay reachable on every host, so one tunnel can
// carry them all.
const appHost = new URL(APP_URL).hostname;
const world = ["booking", "acme", "browserbase"];
const hosts = [
  { host: new URL(ATLAS_URL).hostname, prefix: "atlas" },
  { host: new URL(COMPANY_URL).hostname, prefix: "company" },
  { host: new URL(BOOKING_ISSUER).hostname, prefix: "booking" },
  ...(PERSON_SERVER_MODE === "acme"
    ? [{ host: new URL(PERSON_SERVER_URL).hostname, prefix: "acme" }]
    : []),
  { host: new URL(BROWSERBASE_MCP_URL).hostname, prefix: "browserbase" },
  // The names a local Introspection stack's egress sends these as.
  { host: "booking.flightsector.localhost", prefix: "booking" },
  { host: "browserbase.flightsector.localhost", prefix: "browserbase" },
].filter(({ host }) => host !== appHost);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // A page to present: no dev badge over the phone.
  devIndicators: false,
  // The page and the world it shares with aauth-travel, as TypeScript source.
  transpilePackages: [
    "introspection-example-travel-demo-ui",
    "introspection-example-travel-demo-flow",
  ],
  allowedDevOrigins: hosts.map((h) => h.host),
  async rewrites() {
    return {
      beforeFiles: hosts.map(({ host, prefix }) => {
        const passthrough = [
          ...(world.includes(prefix) ? world : [prefix]),
          "_next",
        ]
          .map((p) => `${p}/`)
          .join("|");
        return {
          source: `/:path((?!${passthrough}).*)`,
          has: [{ type: "host", value: host.replace(/\./g, "\\.") }],
          destination: `/${prefix}/:path`,
        };
      }),
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
