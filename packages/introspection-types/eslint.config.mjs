import { builtinModules } from "node:module";
import { config } from "@repo/eslint-config/base";

// This package must run in browsers, so it may not import Node built-ins.
const message = "Node built-ins are not available in the browser.";

export default [
  ...config,
  {
    files: ["src/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: builtinModules.map((name) => ({ name, message })),
          patterns: [{ group: ["node:*"], message }],
        },
      ],
    },
  },
];
