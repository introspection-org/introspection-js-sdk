import type { NextConfig } from "next";

import { ATLAS_URL, COMPANY_URL } from "./lib/origins";

// Atlas and Flight Sector are each their own https host; this one process
// answers for both by rewriting each host to its routes.
const hosts = [
  { host: new URL(ATLAS_URL).hostname, prefix: "atlas" },
  { host: new URL(COMPANY_URL).hostname, prefix: "company" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
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
};

export default nextConfig;
