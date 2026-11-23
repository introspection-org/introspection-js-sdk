import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // A page to present: no dev badge over it.
  devIndicators: false,
};

export default nextConfig;
