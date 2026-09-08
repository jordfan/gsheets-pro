import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // test/live is opt in and needs a real spreadsheet and a token.
    exclude: ["node_modules/**", "dist/**", "test/live/**"],
    environment: "node",
    testTimeout: 20_000,
  },
});
