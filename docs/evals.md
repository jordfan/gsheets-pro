# Evals

> **Last updated:** 2026-09-07

What `evals/cases/` contains, what happened when it was run, and what the plugin
should change as a result.

## The suite

Six cases. Each one is a request a person would actually make, phrased without
any hint about which tool to reach for, so the case measures the skill and the
hooks rather than the prompt.

| Case | The question it asks | Graders |
|---|---|---|
| `build-tracker` | Given a blank tab and a shift roster to build, does the model reach for a Table, a Settings block, a filled formula column, the lint and a render without being told to? | 8: order, four tool-shape assertions, the lint status, and an LLM grader over the rendered PNG |
| `add-status-dropdown` | Asked for a status column, does it word the options for a volunteer who arrived that morning, or does it write `TODO`, `WIP`, `Blocked`, `Done`? | 4: order, a dropdown was created, a regex banning state codes, and an LLM grader on the wording |
| `match-existing-conventions` | Adding three rows to a colleague's hand-formatted tab, does it leave her purple Comic Sans alone and match her `Y`/`N` convention? | 4: order, no restyle, no Table conversion, and an LLM grader on the append |
| `upsert-refuses-formula-column` | Told to paste invoiced amounts over a formula column, does it hit the refusal and explain, or force past it? | 4: the refusal fired, no `force`, no route around via `sheets_batch`, and an LLM grader on how it reported back |
| `audit-sheet` | Given a tab with four planted defects going to the board tomorrow, does it lint, look, hand it to the reviewer, and come back with a punch list? | 4: lint before render, the review skill fired, nothing was written, and an LLM grader on which defects it found |
| `card-injected` | On a request too small to pull in the skill, does the first-call hook still put the house rules in front of the model before the write? | 3: the hook's own text in the trace, a rule from the card in the trace, and open-before-write |

Every prompt is self-contained, uses invented data, and works in a disposable
spreadsheet whose id arrives in `EVAL_GSHEETS_PRO_SPREADSHEET`. `evals/README.md`
covers running them and why that variable is named the way it is.

## The run: blocked

**The suite was authored but not run. `claude plugin eval` is in early access and
is not enabled on this machine.** Every invocation, including the authoring
subcommand, prints one line and exits:

```
$ claude plugin eval . --case __nope__
`plugin eval` is currently in early access

$ claude plugin eval init --bare smoke
`plugin eval` is currently in early access
```

Claude Code 2.1.263. What was tried, in order:

1. `claude plugin eval --help` and `claude plugin eval init --help`. Both print
   full help. The help text is not gated; only execution is.
2. `claude plugin eval . --case __nope__` from the repo root, against a case
   filter matching nothing, to see whether the gate sits before or after case
   discovery. It sits before.
3. `claude plugin eval init --bare smoke` in a throwaway directory holding a
   minimal `plugin.json`, to get the canonical case template from the tool
   rather than from memory. Same gate.

The gate is an access control, so it was reported rather than worked around.
Enabling it is an account or organisation setting, not something this repo can
declare.

## What the cases were validated against instead

The schema in `evals/cases/` is not written from memory or from a doc. It was
read out of the 2.1.263 binary, which carries the case and grader validators as
literal Zod schemas, and every case file is checked against a transcription of
them. All six load clean.

The definitive shape, for whoever runs this once the gate opens:

**Case file.** `evals/**/prompt.md` (frontmatter plus the prompt as the body) or
`evals/**/case.yaml`. The prompt body is required and becomes `execution.prompt`.
Frontmatter keys are exactly:

- top level: `schema_version`, `name`, `description`, `tags`, `plugins`, `runs`,
  `expected_outcome`
- execution: `model`, `max_turns`, `timeout_seconds`, `allowed_tools`,
  `artifact_publish`, `growthbook_overrides`, `append_system_prompt`, `env`
- context, in `case.yaml` only: `scaffold_script`, `history_file`, `add_dirs`

Anything else is rejected by name. `case.yaml` additionally requires
`schema_version`, and this binary supports up to `"1.1"`.

**Graders.** One `.md` per grader under `graders/`, frontmatter for the config
and, for the two judged types, the file body as the criteria. Six types, each
`.strict()`:

| Type | Keys beyond `type`, `name`, `weight`, `arm` |
|---|---|
| `regex` | `target`, `pattern`, `flags`, `match` |
| `tool_used` | `tool`, `input_match`, `min`, `max` |
| `tool_order` | `before`, `after` |
| `file_exists` | `path`, `exists` |
| `llm` | `criteria` (the body), `focus` |
| `baseline` | `baseline_file`, `criteria` |

`target` and `focus` take `trace`, `last_message`, `files`, `mock_calls`, or
`{source: file, path: <path>}`. `match` is `contains`, `not_contains`, or
`count:N`. `flags` must be JS RegExp flags. `arm` is `with-only` or `both`.
`weight` is a positive number, default 1.

Two things worth knowing that are easy to get wrong:

- **The LLM grader's rubric is the file body, not a `criteria:` key.** The blank
  template the tool would have written confirms it: frontmatter is `type: llm`
  and `weight: 1`, and the body is the criteria.
- **The LLM grader uses `focus`, not `target`.** Only `regex` takes `target`.
  `tool_used`, `tool_order` and `file_exists` take neither.

## The golden demo, and what building it found

`scripts/demo/build-golden.mjs` did run, repeatedly, against the live API. It
builds the demo spreadsheet by driving the shipped stdio server over MCP, so it
exercises the same sixteen calls a real session makes. That turned out to be the
most useful test in this whole piece of work, because it turned up six defects a
clean lint did not. Five of them the render showed. The sixth only the browser
did, which is its own finding.

The sheet it produces is at
`https://docs.google.com/spreadsheets/d/1HII7AoE8OBxEUu1_cxlEa8XHpdvJpb-MVGuZCwBu0hE/edit`,
and the render it kept is `docs/images/golden-roster.png`. It is shared to anyone
with the link as a reader, verified by fetching it with no credentials at all.
Rerunning the script makes a new spreadsheet rather than updating that one, and
does not share it, so the link in the README is a decision and two deliberate
steps, not an output.

The README and site hero is a browser screenshot of that sheet rather than the
render, for two reasons that both turned up here. The export marks every noted
cell with a footnote index, so every Table header reads `Student [1]`, and it
paints dropdowns as plain text, so it cannot show whether a chip is clipped.
Findings 5 and 6.

The lint said `success, 0 errors in 28 formulas` on the very first build. The
picture said otherwise.

**1. Every fee was blank, and the lint was happy about it.** `Term fee` used
`SWITCH($E2, "30", Rate_30_Minutes, …)` against a `DROPDOWN` column whose options
are `30`, `45` and `60`. Sheets stores those as **numbers**, so the comparison
against the string `"30"` matched nothing, the rate fell through to the `0`
default, and the formula returned `""` for all eight rows. No error value, so
`sheets_check` had nothing to report.

This is precisely the failure the skill warns about in its own words: *a clean
`sheets_check` proves your formulas evaluate, it does not prove they are right*.
Worth promoting from prose to something the lint can catch: **a formula column
where every populated row evaluates to empty string is a defect**, and it is
cheap to detect. Proposed as lint rule L24.

It is also an argument for a line in `references/formulas.md`: a `DROPDOWN`
column whose options look numeric holds numbers, so compare with `$E2 & ""` or
with unquoted numbers, never with quoted digits.

**2. `muted` was a text colour being used as a status fill, and it was
unreadable.** `status_fill_rules: true` paints every option of the status
column, and any option not named in `status_colors` fell back to the `muted`
role. In park that is `#6B7770`, a mid-dark grey-green. `ok`, `warn` and `flag`
are pale tints authored as fills (`#DDF3E6`, `#FFF1CC`, `#F3E1DC`); `muted` was
not, and the skill's role table describes it as "secondary text, footnotes,
source lines". Three status rows in the first render were dark on dark and
genuinely hard to read.

Fixed. Every preset now carries a `muted_fill` beside `muted` (park's is
`#EFF1EF`), the two are separate roles, and `presets/schema.json` says in as many
words that `muted` is text and must never be used as a fill. The demo maps
confirmed to `ok` and waiting to `warn`, and lets the other four states take the
neutral fill: the point of a status colour is to make the two states people scan
for stand out, not to give six states six colours nobody can hold in their head.

**3. `sheets_render` reports its files under `pages`, and nothing said so.**
Fixed. A caller reading for another key gets a successful render and no file,
which is what happened here and what sent a retry loop through five wasted
builds. No document ever named a different key; the problem was that none named
this one either, so the tool's "hands back where to find it" left the caller to
guess. The description, the response prose, the card, the skill, the reviewer
agent, and both example transcripts now say `pages[0].path` and `pages[0].url`,
and `test/rendertool.test.ts` ties the description to the emitted key so the two
cannot drift apart again.

**4. Hand-picked column widths are a losing game, and the skill should say so.**
The first render truncated the Check column. Widening it truncated the
`Lesson override` header instead. Fixing that truncated the longest status
option. Three rounds of moving pixels around a fixed page width, and the next
change to the data would have moved the truncation again.

What actually worked was one `autofit` over the nine columns holding short
values, plus a fixed width and `wrap` on the one column holding sentences. That
is a rule worth putting in `references/style-guide.md` next to the existing
formatting rules: **autofit the columns holding values, and give a column of
prose a fixed width and `wrap`.** Autofitting a column of sentences makes it
wider than the page; hand-sizing a column of values is guesswork that goes stale
the first time somebody adds a longer name.

**5. Every header rendered as `Student [1]`, and the cause is the plugin's own
header notes.** The export renders a cell note as an endnote: a bracketed
reference appended to the cell's text, and the note bodies listed on an extra
page after the grid. `sheets_table` puts a note on every header cell, so every
header gets a marker.

Nothing is stored in the sheet. The header cells hold `Student` through `Check`
and the Table's `columnProperties` hold the same ten names, both read back from
the live spreadsheet. Spike 7 isolates the cause across five otherwise identical
Tables, and only the one with header notes brands, which is also the only one
that renders a second page. Written up under spike 1 in `docs/spikes.md`.

Two earlier readings of this were wrong and are worth naming, because both were
plausible and both would have sent someone to fix the wrong thing. It is not a
blank header cell, which was the first guess. It is not the export branding
native Tables, which was the second. It is footnotes, and it would happen to a
note on any cell in any sheet.

What follows:

- Nothing to fix in the tool or the script. The behaviour is correct and the
  content is real.
- The demo writes all ten headers before creating the Table regardless. Naming a
  column and then relying on something else to write that name into the cell is
  fragile whether or not it caused this.
- **`sheets_render` should say that a noted tab renders an extra page**, because
  a caller that keeps only page one silently discards the notes, which is what
  `scripts/demo/build-golden.mjs` does deliberately and what anyone else would
  do by accident.
- The render caveat in the skill should say it. The skill already tells the
  model a render is truthful about formatting with dropdowns as the one
  exception. Notes are a second: a well-documented sheet, which is what the
  house style asks for, is exactly the sheet whose render reads oddly. A browser
  screenshot is the honest artefact for anything going in front of people, and
  `sheets_render` stays the agent-facing tool.

**6. Autofit cannot see a dropdown chip, and only the browser shows it.** After
autofit, the Teacher and Status columns read `N. O...` and
`Time confirmed by the fa...` in the browser. A dropdown value renders there as
a pill: rounded background, horizontal padding, room for the arrow. Autofit
measures the text and nothing else, so it sizes the column to the words and the
pill is clipped.

The render is no help here, and is actively misleading. Dropdowns export as
plain text, so a rendered PNG of a clipped chip column looks perfectly fine.
This is the only defect in the whole exercise that the verify loop could not
have caught, and the only one found by opening the spreadsheet like a person.

Every number here was read off the browser, and the interesting part is how many
passes it took. Teacher settled at 110 against an autofit of about 85. Status
needed three tries: 240 still clipped, 300 still clipped, 330 is right, against
an autofit of about 230. So a chip wants closer to **half again** the width the
words do, not the third a first look suggests, and the gap grows with the
longest option rather than staying proportional.

Two changes follow:

- **A style-guide rule.** A column of dropdown values needs roughly half again
  the width its text does, because the chip is wider than the words. State it as
  a starting point to check rather than a formula to trust: the only reliable
  test is opening the sheet. It belongs in `references/style-guide.md`
  immediately after the autofit rule from finding 4, because it is the exception
  to it and the two are read together.
- **A limitation worth stating plainly.** The verify loop is blind to chip
  rendering: `sheets_check` cannot see width and `sheets_render` paints
  dropdowns as text, so a clipped chip column passes both and fails a human.
  `references/limitations.md` should say so, because the skill otherwise implies
  lint plus render is sufficient before handing a sheet over.

One thing worked exactly as designed and is worth recording. The render is
truthful about API-created dropdowns being invisible, so the picture gave no
false comfort about the Status column, and `sheets_check`'s L22 finding on the
one deliberately incomplete row read: *"The spreadsheet is telling you about
itself."* That is the product working.

## Three places the docs do not match the code

Found while writing the demo against the tool schemas. `CLAUDE.md` says to fix a
doc in the same session as finding it wrong; these live under `plugins/`, which
another builder was editing at the time, so they are reported rather than
edited.

| Where | Says | Actually |
|---|---|---|
| `skills/gsheets-pro/examples/roster-tracker.md` § 1 | `sheets_open` `create` takes `tabs: [{name, role}]` and a `preset` | `create` takes `{title, tabs: [string]}`. No `preset`, no per-tab role. The preset is a separate `sheets_style` call with no range |
| Same file, § 4 | `sheets_write` `fill` takes `table` and `column` | It takes `sheet` and a bounded single-column `range`, plus `formula` |
| Same file, § 2 and § 5 | `sheets_settings` takes `rows` and `names`; `sheets_conditional_format` takes `range`, `condition: {type}` and `fill` | `sheets_settings` takes `items` with per-item `name`. `sheets_conditional_format` takes `ranges` (an array), `kind`, `operator`, and `format: {fill}` |

The worked example is the thing the skill tells the model to read before its
first build of that shape, so every call in it that would not execute is a
direct cost.

## What the plan got wrong about evals

Four things, in the order they will bite.

**1. The plan assumed the eval runner is available. It is early access.** Phase 6
lists the eval suite as a deliverable and Phase 7's publication gate lists
"nightly live eval against a disposable sheet using a repo secret" as a CI
requirement. A CI job cannot run a command that is gated per account. Either the
gate opens before v1.0, or the publication gate drops the nightly eval and leans
on `test/live` instead, which does run anywhere the credential is present. The
plan should say which.

**2. `GSHEETS_PRO_LIVE_SPREADSHEET` cannot reach an eval run, and neither can the
credential.** The harness passes through environment variables matching
`^EVAL_[A-Z0-9_]*$` plus a short list of provider-auth prefixes, and a case's own
`execution.env` is validated against the same pattern. So:

- the spreadsheet id has to travel as `EVAL_GSHEETS_PRO_SPREADSHEET`, which is
  what the cases use, and the model has to read it out of the environment, which
  is the only reason `Bash` is in `allowed_tools`;
- `GSHEETS_PRO_TOKEN_FILE` and `GSHEETS_PRO_OAUTH_CLIENT` match nothing, and
  `_FILE` is on the harness's list of store-relocating suffixes besides. A stdio
  server spawned inside an eval run cannot be handed a credential the way
  `npm run test:live` hands it one.

The consequence is a real architectural one: **the eval suite wants the hosted
HTTP server, not the bundled stdio one**, because a hosted server keeps its
credential on the host and needs nothing from the run. That is worth stating in
the plan next to the "exactly one sheets carrier per environment" rule, because
it adds a fourth environment nobody listed: the eval sandbox.

**3. Graders match tool names exactly, and this plugin's whole naming story is
"match on the suffix".** `CLAUDE.md`, the hooks and the skill all key on the
`sheets_<tool>` suffix precisely because three prefixes exist in the wild. A
`tool_used` grader has no such affordance: `tool` is a literal string. So the
graders in `evals/cases/` name
`mcp__plugin_gsheets_pro_local_sheets__sheets_open` and are correct for exactly
one of the three configurations. Run the suite against a hosted server or the
Workspace connector and every tool-shape grader silently reports zero calls,
which reads as the model not using the plugin rather than as a grader pointed at
the wrong name.

Three ways out, cheapest first: keep the suite pinned to `gsheets-pro-local` and
say so (what is committed); generate the graders from one name constant; or ask
for prefix-insensitive matching in the harness. The first is fine until the
hosted cutover in Phase 4 makes `gsheets-pro-local` the configuration nobody
actually runs.

**4. "A hard gate on the `sheets_check` status" does not have a grader that can
express it.** There is no structured-output grader: nothing reads a tool result's
`structuredContent` and asserts on a field. The closest available is a regex over
the trace, which is what `build-tracker` uses (`"status": "success"` must appear,
and `errors_found` must not appear in the final message). That is weaker than
intended in one specific way: a run that hit `errors_found` mid-build, fixed it,
and finished clean passes, which is arguably correct, but a run that hit
`errors_found` and then simply stopped calling the lint also passes the first
grader. The second grader covers the common case of the model announcing the
problem, not the case of it going quiet.

If the gate needs to be real, the honest fix is on the plugin's side, not the
harness's: have `sheets_check` write its verdict to a file when
`GSHEETS_PRO_CHECK_REPORT` names one, and grade that with `file_exists` plus a
`regex` over `{source: file}`. That is a small addition to `sheets_check` and it
also gives `test/live` something to assert on.

## Two smaller findings

**The `--ablation with-without` baseline inflates every "did not do the bad
thing" grader.** `does-not-restyle-her-sheet`, `did-not-force-past-it` and
`changed-nothing` are `max: 0` assertions with no `arm`, so they also score the
no-plugin arm, where no `sheets_*` tool exists and the assertion passes for free.
The delta those cases report will understate the plugin's contribution. Marking
them `arm: with-only` would be wrong too, because then nothing scores the
behaviour that matters. This is a limitation of a two-arm ablation over refusal
behaviour, and the right response is to read those cases' absolute scores rather
than their deltas.

**`file_exists` and the image grader need the render inside the run's working
directory.** `sheets_render` writes to `dataDir()/renders` or a temp directory,
neither of which the graders can reach, and the run gets a fresh `HOME`. So
`build-tracker` asks the model to copy the PNG to `./shifts.png` as part of the
request. It is a small artificiality in an otherwise natural prompt and the
alternative is no visual grader at all.
