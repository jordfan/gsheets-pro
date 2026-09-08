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
 *   npm run test:live
 *
 * Without GSHEETS_PRO_LIVE_SPREADSHEET every test skips itself, so the file is
 * safe to run in CI with no credentials. Cases run one after another because
 * they share tabs and because the API allows 60 reads a minute.
 */
export default defineConfig({
  test: {
    include: ["test/live/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
