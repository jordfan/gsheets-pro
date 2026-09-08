# Limitations

What gsheets-pro cannot do, stated plainly. Most of these are limits of the
Google Sheets API itself, not gaps in this project's coverage of it: no
amount of future work closes them without Google adding the underlying
request type. A few are deliberate tradeoffs this project made on purpose.
Where a workaround exists, it is named.

This is the human-facing version. The model-facing version, which Claude
reads before it hits one of these mid-build, is
`plugins/gsheets-pro/skills/gsheets-pro/references/limitations.md`. The two
are kept consistent; if you find them saying different things, that is a
bug, please file it.

## Not reachable through the Sheets API at all

**Named functions.** Data > Named functions is interface-only. There is no
API request that creates, edits, or lists one. A spreadsheet that already
has them keeps working and formulas can call them, but this project cannot
touch them. Use a `LET` inside the formula, or a helper column, instead.

**Apps Script.** No script creation, editing, or execution. A different
Google API governs Apps Script and this project does not use it.

**Threaded comments.** Comments live in the Drive API, not the Sheets API,
and this project only speaks the Sheets API for spreadsheet content. It
writes cell **notes** instead, which are arguably the better tool for
in-sheet documentation anyway: permanent, attached to the cell, and nobody
can resolve one away. But it means the plugin cannot read or write a
comment thread, so it also cannot see a question a colleague left in one.

**Dropdown chip colors.** No data validation rule carries a color field in
the API, in either direction. The only keys a rule returns are `condition`,
`strict`, and `showCustomUi`; the colored pill you see in the Sheets UI is
not visible to any API call, before or after it exists.

**Rewriting a validation rule someone colored by hand destroys the colors.**
This was measured directly (`docs/spikes.md`, spike 4): re-applying
`setDataValidation` with a condition byte-identical to the one already
there wiped colors a person had set in the interface. Not changed, wiped,
and unrecoverable, because they were never readable through the API in the
first place, so nothing could have read and restored them. This is why the
plugin tracks which validation rules it created and refuses to rewrite any
rule it did not create without an explicit `force`. If a dropdown on a
sheet someone else colored needs a new option, the plugin says so and asks
a person to add it by hand instead of touching the rule itself. On a sheet
the plugin built end to end, a conditional-format rule emulates the colored
look and survives being rewritten normally.

**Table footers destroy the last row of data.** A native Table's
`footerColorStyle` reads like a cosmetic color setting. It is not one:
setting it converts the Table's last data row into a footer and overwrites
that row's cells with `SUM` aggregations, silently, with no error. A row
holding real values becomes a row of totals formulas, and the original
values are gone. Because of this, presets only ever apply header and band
colors, never a footer color, and the tools never send that field on their
own. A totals row is a legitimate thing to want, but because asking for one
means asking the tool to destroy a row of real data, it has to be an
explicit request in those terms, not something that falls out of choosing a
preset. Put a summary block above the Table, or on another tab, instead.

**Data tables and what-if analysis.** Not supported.

## Supported, but not first class yet

**Charts, pivot tables, slicers, and filter views** go through the raw
batch-update escape hatch, which reaches every request type the Sheets API
offers with sheet names and cell ranges resolved for you, but applies no
styling defaults and no preset awareness. A chart built this way looks like
the Sheets default, not like the rest of a themed spreadsheet.

**The declarative one-call workbook builder is not in v1.** Building a
typical tracker today is a short sequence of calls (create the Table, add
the settings block, fill the data) rather than one declarative call. The
one-call version is on the v1.1 roadmap.

## Rendering

Rendering a tab to an image uses an undocumented Google export endpoint,
which is why it is fenced off behind a dedicated tool rather than exposed
as a raw API wrapper. What it gets right is more than you might expect:
fills, fonts, borders, banding, merged cells, column widths, and
conditional-format rules all paint correctly, a conditional fill correctly
overrides banding underneath it, and a frozen header repeats on every page
of a multi-page render.

**No dropdown ever renders as a pill**, though what you see depends on who
made the rule:

| Who made the rule | How it renders |
|---|---|
| Created through the API | Plain black text. No pill, no arrow, no color |
| Colored by hand in the Sheets interface | Colored text, still no pill |

This cuts both ways. A render can confirm that a colleague's hand-set chip
colors survived a change you just made near their dropdown, which makes it
a cheap sanity check. A render cannot confirm that a validation rule exists
at all, because an intact, uncolored, API-created dropdown looks pixel for
pixel identical to a cell with no rule on it. The lint tool
(`sheets_check`) is the authority on whether validation exists; a render is
not evidence either way.

A render never comes back as image bytes over MCP, since Claude Code
mishandles those. It comes back as a file path on your own machine, or as a
short-lived signed URL when the server is hosted for a team. Rendering
needs `pdftoppm` from the `poppler` package installed on whichever machine
runs the server; `gsheets-pro doctor` checks for it. On a small hosted
instance, renders are processed one at a time and size-capped, so a very
large sheet can come back scaled down.

## Authentication

**Setting up your own OAuth client is a real fifteen-to-twenty-five-minute
chore the first time.** There is no way around that short of running a
verified OAuth application that holds other people's tokens, which this
project deliberately does not do. `/gsheets-pro:setup` and
`gsheets-pro doctor` exist to make that chore as short and as legible as
possible, and anyone with the gcloud CLI already installed can skip it
entirely with Path B.

**An unpublished OAuth consent screen expires its refresh token after seven
days.** This is the most common way a working setup quietly breaks: it
works fine for a week and then the credential is simply gone. Publishing
the app during setup avoids this, and `doctor` will flag a consent screen
still sitting in Testing.

**The `drive.file` scope cannot open an existing spreadsheet by id alone.**
It can only reach spreadsheets the plugin created or that you opened
through it by URL at least once. Searching Drive by title needs a third
scope, `drive.readonly`, which Google classifies as Restricted and which
grants read access to your entire Drive, so it is opt-in rather than
requested by default.

**Service accounts have no Drive storage quota**, so a service account
cannot create a new spreadsheet, and every existing spreadsheet it needs to
touch must be shared with it individually. Workable for a fixed, known set
of spreadsheets; a poor fit for anything open-ended.

## Environment

**Stdio servers cannot run in Claude Code cloud sessions.** The
`gsheets-pro-local` plugin, which bundles a stdio server, therefore does
nothing there. Reaching this project's tools from a cloud session or a
scheduled task means running the server over HTTP somewhere reachable; see
`docs/hosting.md`.

**A plugin declared in a repository's own settings does not install in a
cloud run.** This was measured directly (`docs/cloud.md`): the marketplace
is never cloned and the skill comes back unknown, even though repository
hooks and skills in `.claude/` do load in the same run. `gsheets-pro vendor`
exists because of this: it copies the skill, hooks, and presets straight
into a repository's `.claude/` directory, where they do load in a cloud
session, at the cost of needing to be re-run and re-committed after an
update.

**No elicitation.** The server cannot pause mid-call to ask a question
through stateless HTTP or through an aggregator sitting in front of it. So
every confirmation this project needs has to be an explicit argument
(`confirm`, `force`) the caller passes up front, or a permission decision
made by a hook, never an interactive prompt the server itself raises.

**Google's own quota is 60 reads and 60 writes per minute, per user.** One
`batchUpdate` call counts once no matter how many individual changes it
carries, which is why every tool here sends exactly one per call rather
than many small ones. The server backs off and retries on a 429, but a
genuinely large build can still hit the ceiling and pause for a moment.

**Large reads are capped, not truncated.** A tool response tops out around
25 thousand tokens. A read that would exceed that declares its own cap and
paginates rather than silently cutting off in the middle of the data.

## The one that is not a bug

**A clean lint does not mean correct numbers.** `sheets_check` confirms
that every formula evaluates without error. It cannot know whether a range
is off by one row, whether a lookup points at the wrong column, or whether
a reference should have pointed somewhere else entirely. An off-by-one
error produces a spreadsheet that is completely clean by every automated
check here and still wrong throughout. Spot-checking a handful of
calculated cells against their inputs by hand is not something any tool in
this project can do for you, and it is not optional.
