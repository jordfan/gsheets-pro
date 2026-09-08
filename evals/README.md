# The eval suite

Six cases that check the thing this plugin claims to do: that Claude, holding
the skill and the tools, produces a spreadsheet a careful colleague would
recognise as their own, and refuses the writes that would wreck one.

The offline tests in `test/` prove the tools behave. These prove the *model*
behaves: that it opens before it writes, reaches for a native Table rather than
a hand-formatted range, writes status values in plain language, adopts an
existing sheet's conventions instead of restyling them, and treats a refusal as
information rather than an obstacle.

## Running them

```
export EVAL_GSHEETS_PRO_SPREADSHEET=<a disposable spreadsheet id>
claude plugin eval . --allow-tools Bash Read Write Edit 'mcp__*'
```

One case at a time, which is what the Sheets quota wants:

```
claude plugin eval . --case build-tracker --runs 1 --allow-tools Bash Read 'mcp__*'
```

`claude plugin eval` is in early access. On a binary without it enabled every
invocation prints `plugin eval is currently in early access` and exits, and that
includes `claude plugin eval init`. See `docs/evals.md` for what that meant for
this suite.

## The spreadsheet these cases write to

Every case writes to one **disposable** spreadsheet whose id arrives in the
environment variable `EVAL_GSHEETS_PRO_SPREADSHEET`. Nothing in this directory
contains a spreadsheet id, and no case may ever be pointed at a spreadsheet
anyone relies on. Each case creates its own tabs, named for the case and a
timestamp, so two cases never collide and a failed run leaves evidence rather
than wreckage.

The `EVAL_` prefix is not a house style. The eval harness passes exactly two
kinds of environment variable into a run: the ones matching `^EVAL_[A-Z0-9_]*$`,
and a short list of provider-auth prefixes. A case's own `execution.env` is
validated against the same pattern. So `GSHEETS_PRO_LIVE_SPREADSHEET`, the name
the live vitest suite uses, cannot reach an eval run, and the id has to travel
under an `EVAL_` name instead.

Each prompt tells the model the id is in that variable and to read it. That
costs one `Bash` turn per case and is the only reason `Bash` is in
`allowed_tools`.

## Credentials

The same filter is why the cases assume a **hosted** server rather than the
bundled stdio one. `GSHEETS_PRO_TOKEN_FILE` and `GSHEETS_PRO_OAUTH_CLIENT` match
no allowed prefix, and `_FILE` is on the harness's list of store-relocating
suffixes besides, so a stdio server spawned inside an eval run cannot be handed
a credential the way `npm run test:live` hands it one. A hosted server keeps its
credential on the host and needs nothing from the run.

If you are running these against `gsheets-pro-local`, put the token where the
server looks for it by default (`dataDir()/token.json`, per `src/lib/auth.ts`)
rather than trying to pass a path in.

## Quota

Sheets allows sixty reads and sixty writes a minute per user, and the live
vitest suite draws on the same budget. A single eval run of `build-tracker`
spends roughly twenty calls. Run one case at a time, leave a minute between
runs, and do not start a suite while `npm run test:live` is going.

## How a case is put together

```
evals/cases/<name>/
  prompt.md          frontmatter + the prompt, which is the whole request
  graders/*.md       one grader per file: frontmatter is the config,
                     the body is the criteria for llm and baseline graders
```

Grader types are `regex`, `tool_used`, `tool_order`, `file_exists`, `llm`, and
`baseline`. Every grader on a case must pass; the case score is the weighted
share that did.

Two conventions hold across the suite:

**Tool names are written out in full.** Graders match a tool name exactly, so
they name `mcp__plugin_gsheets_pro_local_sheets__sheets_open` rather than the
`sheets_open` suffix the skill and the hooks match on. That makes the graders
correct for the `gsheets-pro-local` configuration and wrong for every other one.
`docs/evals.md` says what to do about it.

**Graders that can only pass with the plugin carry `arm: with-only`.** Under the
default `--ablation with-without` every case also runs with no plugin at all. A
grader asserting that a `sheets_*` tool was called, or that the first-call hook
injected the card, is not a fair thing to score the baseline on: it is an
indicator that the plugin fired, so it is reported rather than scored.
