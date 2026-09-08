# What this plugin cannot do

Stated plainly, so a gap surfaces here rather than as a confusing tool failure
halfway through a build. When one of these blocks a request, say so and offer
the workaround. Do not keep trying.

## Not reachable through the Sheets API at all

**Named functions.** Data > Named functions is interface-only. There is no API
request that creates one. A spreadsheet that already has them keeps working, and
formulas can call them, but the plugin cannot create, edit, or list them. Use a
`LET` inside the formula, or a helper column.

**Apps Script.** No script creation, editing, or execution. A different API
governs that and this plugin does not use it.

**Threaded comments.** Comments live in the Drive API, not the Sheets API. The
plugin writes **notes**, which are the better tool for documentation anyway:
they are permanent, they attach to the cell, and nobody can resolve them away.
It cannot read or write a comment thread, so it also cannot see a question
somebody left in one.

**Dropdown chip colors.** No data validation rule carries a color field in the
API, in either direction. The only keys a rule returns are `condition`,
`strict`, and `showCustomUi`. Colors set through the interface cannot be read
and cannot be written.

**Rewriting such a rule destroys them.** This was measured, with renders before
and after: re-applying `setDataValidation` with a condition identical to the one
already there wiped the colors a person had set by hand. Not changed, wiped, and
unrecoverable, because they were never readable in the first place, so nothing
could have saved them first.

That is why the plugin reports a rule it did not create as `ui_owned` and
refuses to rewrite it without `force`. When a dropdown needs a new option on a
sheet somebody else colored, say so and let a person add it. On a sheet the
plugin built, a conditional format rule emulates the look and survives being
rewritten.

**Data tables and what-if analysis.** Not supported.

## Table footers destroy the last row, so no preset asks for one

A Table's `footerColorStyle` reads like a color setting and is not one. Setting
it converts the Table's last data row into a footer and **overwrites that row's
cells with aggregations**, replacing real values with `SUM` formulas. No error,
no warning. A row reading

```
Oren Whitfield | Clay & Kiln | Pending | 6 | =D5*55
```

comes back as

```
Oren Whitfield | Clay & Kiln | Pending | =SUM(T[Sessions]) | =SUM(T[Fee])
```

The same call without the field leaves the row alone.

So **presets carry header and band colors only, and never a footer color**, and
`sheets_table` does not send the field. A totals row is a real thing somebody
might want, but it is a request to destroy the last row of data and it has to be
asked for in those terms, not arrived at through a palette. Put a summary block
above the Table or on another tab instead, which is where the roster example
puts it.

## Supported but not first class in v1

**Charts, pivot tables, slicers, and filter views** go through `sheets_batch`,
the raw escape hatch, which reaches all of the API's request types with sheet
names and A1 ranges resolved for you. They work. They just get no styling
defaults and no preset awareness, because a chart style system is a design
problem that has not been solved here yet. A chart built this way will look like
the Sheets default.

**`sheets_build`,** the declarative one-call workbook builder, is not in v1.
Build with `sheets_table`, `sheets_settings`, and `sheets_write` in sequence,
which is four calls for a typical tracker.

## Rendering

`sheets_render` uses an **undocumented export endpoint**. It paints more than
expected: fills, fonts, borders, banding, merges, column widths, and
conditional-format rules all come through, a conditional fill correctly overrides
the banding beneath it, and a frozen header repeats on every page.

**No dropdown ever renders as a pill**, but what does render depends on who made
the rule:

| The rule | How it renders |
|---|---|
| Created through the API | Plain black text. No pill, no arrow, no color |
| Colored by hand in the interface | Colored text, still no pill |

Two consequences. A render **can** confirm that a colleague's chip colors
survived whatever you just did, which makes it a cheap check after any work near
their dropdowns. A render **cannot** confirm that a rule exists, because an
intact API-created dropdown is indistinguishable from no rule at all, so a
bare-looking cell is not evidence of anything. `sheets_check` is authoritative
for validation state.

It returns a **file path locally, or a short-lived signed URL when hosted, never
image bytes**. Read the file. Rendering needs `pdftoppm` from poppler on the
machine running the server, and a render on a small hosted instance is
serialized and size-capped, so a very wide sheet may come back scaled down.

## Authentication

**Setup is a real chore for a new user.** Creating a Google Cloud project and an
OAuth client takes 15 to 25 minutes the first time. There is no way around it
short of running a verified OAuth application and holding other people's tokens,
which this project deliberately does not do. `/gsheets-pro:setup` and
`npx gsheets-pro doctor` are the mitigation.

**An unpublished consent screen expires refresh tokens after seven days.** This
is the most common way a working setup breaks. The setup skill says to publish;
`doctor` reports it.

**`drive.file` cannot open an arbitrary existing spreadsheet by id.** Opening
one by URL works. Searching Drive by title needs `drive.readonly`, which Google
classifies as Restricted and which grants read access to every file in the
Drive, so it is opt-in.

**Service accounts have no Drive storage quota**, so one cannot create a
spreadsheet, and every existing spreadsheet must be shared with it individually.
Workable for a fixed set of sheets, poor for anything else.

## Environment

**Stdio servers do not run in Claude Code cloud sessions.** The
`gsheets-pro-local` plugin therefore does nothing there. Host the server over
HTTP for cloud sessions and scheduled tasks.

**A plugin declared in a repository's settings does not install in a cloud
run.** The marketplace is never cloned and the skill comes back unknown, so a
scheduled run would otherwise work without any of these rules. Repository hooks
and skills do load, which is why `scripts/vendor.mjs` exists: it copies the
guide, the hooks, and the presets into the repository's own `.claude/`
directory. `docs/cloud.md` has the measurements.

**No elicitation.** The server cannot prompt mid-call through stateless HTTP or
through an aggregator, so every confirmation is an argument (`confirm`, `force`)
or a permission decision from the guard hook, never an interactive dialog from
the server.

**Google's quota is 60 reads and 60 writes per minute per user.** One
`batchUpdate` counts once regardless of how many requests it carries, which is
why every tool sends one. The plugin backs off and retries on 429, but a very
large build can still hit the ceiling and pause.

**Large reads are capped.** A tool response tops out around 25 thousand tokens.
Big reads declare their own cap and paginate rather than truncating in the
middle.

## The one that is not a bug

**A clean lint does not mean correct numbers.** It means every formula
evaluates. An off-by-one range, a reference to the wrong row, or a lookup
against the wrong column produces an error-free spreadsheet full of wrong
values, and no tool here will catch it. Spot-check a few calculated cells
against their inputs by hand. That check is not automatable and it is not
optional.
