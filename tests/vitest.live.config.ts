import { defineConfig } from "vitest/config";
import base from "./vitest.config";

// Spread rather than `mergeConfig`, which concatenates `include`/`exclude`
// and would keep the base config's exclusion of this very suite.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["tests/live/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
