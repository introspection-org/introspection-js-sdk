import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(process.env.NODE_ENV === "production" && {
    output: "standalone" as const,
  }),
};

export default nextConfig;
