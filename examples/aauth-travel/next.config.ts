import type { NextConfig } from "next";

import { APP_URL, PERSON_SERVER_URL } from "./lib/origins";

// Acme's Person Server is its own origin (an AAuth server identifier has no
// path); this one process answers for it by rewriting that host to /acme/*.
const acmeHost = new URL(PERSON_SERVER_URL).hostname;
const ownOrigin = acmeHost !== new URL(APP_URL).hostname;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The walkthrough reads these files at request time.
  outputFileTracingIncludes: {
    "/": ["./flow/**/*", "./recipe/**/*", "./lib/**/*"],
  },
  allowedDevOrigins: ownOrigin ? [acmeHost] : [],
  async rewrites() {
    return {
      beforeFiles: ownOrigin
        ? [
            {
              source: "/:path((?!acme/|_next/).*)",
              has: [{ type: "host", value: acmeHost.replace(/\./g, "\\.") }],
              destination: "/acme/:path",
            },
          ]
        : [],
      afterFiles: [],
      fallback: [],
    };
  },
  ...(process.env.NODE_ENV === "production" && {
    output: "standalone" as const,
  }),
};

export default nextConfig;
