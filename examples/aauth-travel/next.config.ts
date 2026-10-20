import type { NextConfig } from "next";

import {
  APP_URL,
  BOOKING_ISSUER,
  BROWSERBASE_MCP_URL,
  FLIGHTSECTOR_AS_URL,
  FLIGHTSECTOR_FEDERATED,
  PERSON_SERVER_MODE,
  PERSON_SERVER_URL,
} from "./lib/origins";

// Each AAuth server is its own host (an identifier has no path); this one
// process answers for each by rewriting its host to its routes. A party served
// on the app's own host (or not served at all) keeps its path prefix instead,
// and every prefix stays reachable on every host, so one public tunnel can carry
// the booking provider and the Browserbase mock.
const appHost = new URL(APP_URL).hostname;
const prefixes = ["booking", "acme", "browserbase", "flightsector-as"];
const hosts = [
  { host: new URL(BOOKING_ISSUER).hostname, prefix: "booking" },
  ...(PERSON_SERVER_MODE === "acme"
    ? [{ host: new URL(PERSON_SERVER_URL).hostname, prefix: "acme" }]
    : []),
  { host: new URL(BROWSERBASE_MCP_URL).hostname, prefix: "browserbase" },
  ...(FLIGHTSECTOR_FEDERATED
    ? [
        {
          host: new URL(FLIGHTSECTOR_AS_URL).hostname,
          prefix: "flightsector-as",
        },
      ]
    : []),
  // The names a local Introspection stack's egress sends these as.
  { host: "booking.flightsector.localhost", prefix: "booking" },
  { host: "browserbase.flightsector.localhost", prefix: "browserbase" },
].filter(({ host }) => host !== appHost);
const passthrough = [...prefixes, "_next"].map((p) => `${p}/`).join("|");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // A page to present: no dev badge over the phone.
  devIndicators: false,
  // The walkthrough reads these files at request time.
  outputFileTracingIncludes: {
    "/": ["./flow/**/*", "./recipe/**/*", "./lib/**/*"],
  },
  allowedDevOrigins: hosts.map((h) => h.host),
  async rewrites() {
    return {
      beforeFiles: hosts.map(({ host, prefix }) => ({
        source: `/:path((?!${passthrough}).*)`,
        has: [{ type: "host", value: host.replace(/\./g, "\\.") }],
        destination: `/${prefix}/:path`,
      })),
      afterFiles: [],
      fallback: [],
    };
  },
  ...(process.env.NODE_ENV === "production" && {
    output: "standalone" as const,
  }),
};

export default nextConfig;
