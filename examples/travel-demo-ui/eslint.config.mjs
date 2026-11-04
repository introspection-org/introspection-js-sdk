import { default as nextConfig } from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  ...nextConfig,
  { settings: { next: { rootDir: "." } } },
  { rules: { "@next/next/no-html-link-for-pages": "off" } },
];

export default eslintConfig;
