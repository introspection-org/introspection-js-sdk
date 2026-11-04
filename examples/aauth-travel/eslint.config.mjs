import { default as nextConfig } from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  ...nextConfig,
  // The recipe, vendored or cloned by `pnpm dev`; linted in its own repository.
  { ignores: ["recipe/**", ".introspection-work/**"] },
  {
    rules: {
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default eslintConfig;
