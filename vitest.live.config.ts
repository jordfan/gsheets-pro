import { defineConfig } from "vitest/config";

/**
 * The live suite, which talks to the real Google Sheets API.
 *
 * It is a separate config rather than a flag on the default one so that
 * `npm test` can never reach it by accident. Run it with:
 *
 *   GSHEETS_PRO_LIVE_SPREADSHEET=<a disposable spreadsheet id> \
 *   GSHEETS_PRO_TOKEN_FILE=$PWD/spikes/.secrets/sheets-mcp-token.json \
 *   GSHEETS_PRO_OAUTH_CLIENT=$PWD/spikes/.secrets/sheets-mcp-oauth-keys.json \
 *   npx vitest run --config vitest.live.config.ts
 *
 * Without GSHEETS_PRO_LIVE_SPREADSHEET every test skips itself, so the file is
 * safe to run in CI with no credentials.
 */
export default defineConfig({
  test: {
    include: ["test/live/**/*.test.ts"],
    environment: "node",
    // Real API calls, run in order, with quota backoff behind them.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
