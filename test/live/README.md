# The live suites

These talk to the real Google Sheets API. `npm test` never reaches them; they
run only through their own config:

```
GSHEETS_PRO_LIVE_SPREADSHEET=<a disposable spreadsheet id> \
GSHEETS_PRO_TOKEN_FILE=... GSHEETS_PRO_OAUTH_CLIENT=... \
npm run test:live
```

Without `GSHEETS_PRO_LIVE_SPREADSHEET` every case skips itself, so the files
are safe in CI with no credentials.

## Every live file builds its context through `paceContext`

```ts
import { paceContext } from "./pacing.js";

beforeAll(async () => {
  ctx = paceContext(await getContext());
});
```

That one line is the whole contract, and a new file is not finished without
it. The suites share one Google project and one per-user quota, so a file that
opts out does not only risk its own cases, it spends the budget the other
files are counting on.

The reason it matters is that quota failures do not look like quota failures.
Sheets allows sixty reads and sixty writes a minute per user, and a single
live case spends three or four calls inside the tool plus one or two reading
the result back. Run enough cases flat out and a 429 lands in the middle of an
assertion, where it surfaces as `expected 'ok' to be 'success'` or as a row
that is not there, and reads as a bug in the tool. Two people have now spent
time chasing one.

`paceContext` wraps the shared Google clients in a token bucket and a short
retry, so both the test's own calls and the ones the tools make underneath are
held under the limit. Nothing else in a live file needs to wait or retry by
hand. `test/pacing.test.ts` covers the limiter offline.

## Conventions

- Create your own tabs, name them so it is obvious which suite owns them, and
  either delete them at the end or reset them at the start. Never touch a tab
  you did not make.
- Invent every name in the fixture data. No real people, schools, or vendors.
- Leave a minute between full runs. The pacer keeps one run under the limit;
  it cannot give back what the previous run just spent.
