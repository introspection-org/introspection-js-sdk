import { default as nextConfig } from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  ...nextConfig,
  // Vendored from the recipe repository; linted there.
  { ignores: ["recipe/**"] },
  {
    rules: {
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default eslintConfig;
