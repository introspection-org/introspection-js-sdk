import type { NextConfig } from "next";

import { BOOKING_ISSUER, PERSON_SERVER_URL } from "./lib/origins";

// Each AAuth server is its own host (an identifier has no path); this one
// process answers for both by rewriting each host to its routes.
const hosts = [
  { host: new URL(BOOKING_ISSUER).hostname, prefix: "booking" },
  { host: new URL(PERSON_SERVER_URL).hostname, prefix: "acme" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The walkthrough reads these files at request time.
  outputFileTracingIncludes: {
    "/": ["./flow/**/*", "./recipe/**/*", "./lib/**/*"],
  },
  allowedDevOrigins: hosts.map((h) => h.host),
  async rewrites() {
    return {
      beforeFiles: hosts.map(({ host, prefix }) => ({
        source: `/:path((?!${prefix}/|_next/).*)`,
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
