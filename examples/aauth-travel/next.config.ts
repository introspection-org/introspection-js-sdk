import type { NextConfig } from "next";

import {
  BOOKING_ISSUER,
  DEMO_AGENT_PROVIDER,
  PERSON_SERVER_URL,
} from "./lib/origins";

// Each AAuth server is its own host (an identifier has no path); this one
// process answers for both by rewriting each host to its routes.
const hosts = [
  { host: new URL(BOOKING_ISSUER).hostname, prefix: "booking" },
  { host: new URL(PERSON_SERVER_URL).hostname, prefix: "acme" },
  { host: new URL(DEMO_AGENT_PROVIDER).hostname, prefix: "agents" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Loaded from node_modules at run time: its Wasm is read beside its JS.
  serverExternalPackages: ["@cedar-policy/cedar-wasm"],
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
