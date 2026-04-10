import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    testTimeout: 60000, // 60s for API calls
    hookTimeout: 30000,
    include: ["**/*.test.ts"],
    setupFiles: ["./setup-env.ts"],
  },
});
