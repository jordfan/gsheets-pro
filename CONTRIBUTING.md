# Contributing to gsheets-pro

Thanks for looking at the code. This is a solo-maintained project with agent
help, so the bar for a change is the same one the maintainer holds their own
work to: it works, it is tested the way this repo tests things, and the docs
say what is actually true.

## Before you start

Read `docs/PLAN.md` once. It carries the research behind every design
decision (the API's hard constraints, why the server is stateless HTTP, why
`ui_owned` dropdowns are never rewritten) and saves you from re-litigating a
choice that was already made for a documented reason. `CLAUDE.md` is the
short version plus the working conventions below.

## Setting up

```
npm ci
npm run build
npm test
```

`npm test` runs the offline vitest suite: a1 parsing, colors, number formats,
field masks, the registry and contract, theme compilation, every lint rule
over fixtures, and the HTTP transport's per-request handling, including the
two-sequential-requests case that catches transport reuse. It needs no
credentials and should stay green on every commit.

```
npm run typecheck
npm run build
node dist/cli.js --help
```

is what CI runs beyond the tests, so it is worth running locally before
pushing.

## Running the live tests

`test/live/` talks to the real Google Sheets API against a disposable
spreadsheet. It is excluded from `npm test` and skips itself with no
credentials, so it never blocks CI or a normal contribution.

```
GSHEETS_PRO_LIVE_SPREADSHEET=<a disposable spreadsheet id> \
GSHEETS_PRO_TOKEN_FILE=/path/to/token.json \
GSHEETS_PRO_OAUTH_CLIENT=/path/to/credentials.json \
npm run test:live
```

Use a spreadsheet you are fine with the suite writing to, deleting tabs on,
and occasionally leaving in a half-built state if a case fails partway
through. Never point it at anything that matters.

### The pacing rule

**Every live test file builds its Google clients through `paceContext`**
(`test/live/pacing.ts`), full stop. This is not a style preference: Sheets
allows 60 reads and 60 writes per minute per user, all live suites share one
project and one quota, and a file that opts out does not just risk its own
cases, it spends the budget every other file in the run is counting on. A
quota failure does not look like a quota failure. It surfaces as `expected
'ok' to be 'success'` or a missing row in the middle of an unrelated
assertion, and it has cost real debugging time more than once. If you add a
live test file, the whole contract is one line in `beforeAll`:

```ts
ctx = paceContext(await getContext());
```

Beyond that: create your own tabs, name them so it is obvious which suite
owns them, and delete them at the end or reset them at the start. Never touch
a tab you did not make. Leave a minute between full local runs of the live
suite; the pacer keeps one run under the limit, it cannot give back what the
previous run just spent.

## Docs must match reality

If you find a path, tool name, or claim in any doc here (`CLAUDE.md`,
`README.md`, `docs/`, a skill, a reference) that does not match what the code
actually does, fix the doc in the same change rather than only mentioning it
in a PR comment. This repo has been burned by drift before, and version
control is where the history of a claim belongs, not a stale sentence left
standing next to a correction. Knowledge and reference files are edited in
place: state what is true now, not what changed. If a fact reverses, the old
text is replaced, not appended to.

## No secrets, no invented-looking realism

- Never commit a token, an OAuth client secret, a real spreadsheet id, a real
  hostname, or a real person's or organization's name. Fixtures, examples,
  and docs use invented names and a throwaway spreadsheet id shape.
  `gitleaks` runs in CI and will catch some of this, but it is not a
  substitute for reading your own diff before you push.
- Credentials come from environment variables or from files named in
  `.gitignore` (`credentials.json`, `token.json`, `*.keys.json`, `.env*`).
  Scripts may read them; nothing should ever print them, log them, or paste
  them into a commit message, an issue, or a PR description.
- If a test needs realistic-looking data, invent it the way the existing
  fixtures do. Do not paste in real rows from a real spreadsheet, even with
  names swapped, since the shape of real data can be identifying on its own.

## Prose style

Anything a person reads: README, skill and reference text, tool
descriptions, error hints, commit messages, this file. Plain, warm, specific.
No em dashes: use a colon, a comma, parentheses, or two sentences instead. No
slang. Say the true thing plainly rather than softening it with a hedge, and
say what a limitation actually is rather than gesturing at it. An error hint
teaches the fix, it does not just name the failure.

## Where things live

`CLAUDE.md` § Shape has the map. In short: `src/tools/<tool>.ts` is one file
per tool, `src/lib/` is the shared library code, `src/lib/lint/<rule>.ts` is
one pure function per lint rule, `plugins/gsheets-pro/` is the skill and
guardrails with no server in it, `plugins/gsheets-pro-local/` adds the
bundled stdio server, and `test/` mirrors `src/` with `test/live/` held
separately.

## Commit messages

Say what changed and why, in one to three sentences. Evidence over
adjectives: name the spike, the test, or the behavior that drove the change
rather than describing it as an improvement. Every commit in this repo ends
with:

```
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

## Opening a pull request

Use the PR template. Fill in the test plan honestly: which offline tests
cover the change, and whether you ran the live suite. A PR that touches a
tool's Sheets API calls without adding or updating an offline test, or
without at least reasoning about which live case would catch a regression,
will get asked for one.

## Reporting a security issue

Do not open a public issue. See `SECURITY.md`.
