import { default as nextConfig } from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  ...nextConfig,
  { settings: { next: { rootDir: "." } } },
  {
    rules: {
      "@next/next/no-html-link-for-pages": "off",
      // As in the examples: the conversation bar follows the run it shows.
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default eslintConfig;
