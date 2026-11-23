import { default as nextConfig } from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  ...nextConfig,
  // The Recipe, linted in its own repository once it is seeded there.
  { ignores: ["recipe/**", "recipe-operator/**"] },
  {
    rules: {
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default eslintConfig;
