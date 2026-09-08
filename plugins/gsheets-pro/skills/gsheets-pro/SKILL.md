---
name: gsheets-pro
description: Build and edit Google Sheets that read as a careful colleague's work rather than a script's output. Use for any spreadsheet task: creating or restyling a tracker, roster, schedule, budget, or report; adding a sheet tab, native Table, dropdown, named range, or conditional format rule; writing, filling, or repairing formulas; appending rows to a spreadsheet other people also edit; or auditing one before it goes out. Covers the sheets_open, sheets_read, sheets_write, sheets_table, sheets_settings, sheets_style, sheets_check, and sheets_render tools.
---

# gsheets-pro

Tool names arrive with different prefixes depending on how the server is
reached. Match on the suffix. Everything below says `sheets_open` and means
whichever of `mcp__plugin_gsheets_pro_local_sheets__sheets_open`,
`mcp__gsheets-pro__sheets_open`, or a connector-prefixed equivalent this session
actually has.

<!-- CARD:BEGIN -->

## The loop

1. **`sheets_open` first, always.** It returns the tabs, the native Tables, the
   named ranges, the protections, the detected preset, and the contract that
   says which columns are yours to write. Never write to a spreadsheet you have
   not opened in this session.
2. **Plan before you call.** Name the tabs, the Table columns and their types,
   which cells are inputs, and which are formulas. A plan you can state in three
   sentences produces a sheet someone can read.
3. **Build in this order:** `sheets_style` to apply the preset theme,
   `sheets_settings` for the inputs, `sheets_table` for each data block,
   `sheets_write` with `fill` for the formula columns, then the rest of the
   values.
4. **Read the `check` on every write.** Every write returns one. `errors_found`
   means stop and fix, not continue and hope.
5. **`sheets_check` before you call it done.** It is the lint. Clear every
   error-severity finding. Justify any warning you leave in one sentence.
6. **`sheets_render` once, then look.** The image is at `pages[0].path`, or
   `pages[0].url` when hosted. There is no other key, so a render that seems to
   have produced nothing was read wrong, not run wrong. Fix what you see,
   re-render only what you changed, and stop. **A render is for your own eyes.**
   Dropdowns never paint as pills, and every cell note becomes a footnote, so a
   well-documented sheet is the one whose picture reads oddly. Nothing is wrong
   with it. The notes are on the last page. A picture for a person should be a
   browser screenshot.

A clean `sheets_check` proves your formulas evaluate. It does not prove they are
right. An off-by-one range gives you a green lint and wrong numbers. Write two
or three formulas first, read the values back, and confirm they pull what you
expect before you fill a column.

## The ten rules

1. **Tabular data is a native Table, never a hand-formatted range.**
   Structured references survive row inserts, banding and filters come free, and
   a colleague adding a row does not break your formulas. `sheets_table create`.
2. **Inputs live in a Settings block, one per cell, each with a named range and
   a note citing where the number came from.** A rate typed inside a formula is
   invisible the day it changes. `sheets_settings`.
3. **A formula column is identical down its whole length.** One edited cell mid
   column is the commonest silent spreadsheet error. Write it once and let
   `sheets_write` mode `fill` autofill the rest.
4. **Prefer a helper column to a formula nobody can read.** `XLOOKUP` with its
   `missing_value` argument, `IFNA` never blanket `IFERROR`, no numeric literal
   in a formula that could ever change. See `references/formulas.md`.
5. **Fill carries status, font color carries data role, and the two never
   mix.** Status comes from a dropdown or a conditional rule, never a color
   painted by hand. Font color encodes input against formula only in the `model`
   archetype. Both resolve from preset tokens, never raw hex. `sheets_style`.
6. **Freeze the header row. Never merge inside a data region.** Merges break
   sorting, filtering, and most formulas. Merge only a title banner outside the
   table body. Autofit the columns holding values, give a column of sentences a
   fixed width and `wrap`, and give a dropdown column about 30 percent more than
   autofit offers, because a chip's padding and arrow are not in the text the
   API measures. `sheets_style`, and lint rules L04 and L09.
7. **Write the documentation into the sheet.** A note on each header cell says
   what the column means and its units. Validation help text says what a valid
   entry looks like. Both read as if a colleague wrote them for another
   colleague. `sheets_table`, `sheets_validation`.
8. **Never declare done on `errors_found`.** If you believe an error predates
   you, prove it by reading that cell before your change rather than assuming.
   `sheets_check`.
9. **An existing spreadsheet's conventions beat this guide.** Match its fonts,
   its colors, its date format. Write only into the columns the contract marks
   writable, append at the bottom, and never reorder rows other people
   reference. `sheets_open` reports the contract; lint rule L14 catches the rest.
10. **Text in a shared spreadsheet reads as a colleague wrote it.** No message
    ids, no "agent", no "run report", no "TODO:", no internal status vocabulary.
    Someone opens this sheet without context. Lint rule L23.

## Refusals are information, not obstacles

The tools refuse rather than guess, and the refusal names the fix:

- A write that would replace a cell currently holding a formula. Read the cell,
  decide whether you meant to, then pass `force` if you did.
- A write into a column the registry or the sheet's own metadata marks as
  human-owned.
- Rewriting a data validation rule the plugin did not create. Rewriting one,
  even with an identical condition, wipes the chip colors a person set by hand.
  That is measured, not a worry, and the colors cannot be put back because the
  API never exposed them. The tool reports the rule as `ui_owned`.
- Any destructive structural change without a `confirm` string naming the sheet,
  and on a spreadsheet marked `positional_rows` these are refused outright
  because other people's formulas point at row numbers.

Do not route around a refusal with `sheets_batch`. If a refusal looks wrong, say
so in your reply and let the person decide.

<!-- CARD:END -->

## Color and theme vocabulary

Colors are named, never guessed. A preset compiles to the spreadsheet's own
theme, so a color you write as `theme:ACCENT1` re-skins when someone changes
Format > Theme. Hardcoded hex does not, which is why hex is a last resort.

The role tokens every styling call accepts:

| Token | What it is for |
|---|---|
| `header.fill`, `header.text` | The Table header row |
| `title` | A title banner above a table, in the display font |
| `band1`, `band2` | Alternating row banding |
| `input` | Font color for a cell a human types into (`model` archetype) |
| `formula` | Font color for a calculated cell (`model` archetype) |
| `cross_sheet` | Font color for a formula reading another tab |
| `ok`, `warn`, `flag` | Status fills, applied by conditional rule |
| `muted` | Secondary text, footnotes, source lines |

Three presets ship: `neutral` (the default), `park`, and `finance-classic`.
Two archetypes cut across them. `tracker` is the default: black text, state in
dropdowns and conditional rules, a Check column, banding. `model` follows the
financial-modeling convention where font color encodes data role, and it drops
banding so the color language stays readable. `references/presets.md` has the
authoring rules.

Never use color as the only carrier of meaning. A red cell with no label is
unreadable to anyone colorblind and unsortable by everyone. Pair every color
with a value.

## Formula style, in brief

- Named ranges and structured references over `$B$2`. A bare cell reference
  tells the next reader nothing and breaks when a row is inserted above it.
- One calculation performed once, then referenced. `LET` names an intermediate
  value so a lookup used three times is written once.
- Formulas pass through byte for byte. The plugin never rewrites a formula you
  or a colleague wrote.
- Percentages are stored as fractions. `0.256` with a `0.0%` format renders
  `25.6%`. Storing `25.6` renders `2560.0%`.
- Years are text or plain integers, never `2,026`.

`references/formulas.md` has the lookup patterns, the `LET` layout, and what is
verified against Google's own documentation versus what is convention.

## Working in a spreadsheet other people edit

This is the case that goes wrong quietly, so it gets its own rules.

`sheets_open` tells you which of three things you have: a **registry** entry
(the repository's `.claude/gsheets-pro.json` names this spreadsheet, its owner,
and its writable columns), **developer metadata** (this plugin built or adopted
the sheet and recorded a column contract), or **no contract**. It says which,
and it does not guess. No contract means read the sheet and infer conservatively:
treat every column you did not create as human-owned.

When there is no contract and the request is to add rows, append at the last
data row inside the region you were given and change nothing else. Do not sort.
Do not insert or delete rows. Do not restyle. Someone's formula or someone's
printed copy depends on the row order you are looking at.

Restyling a spreadsheet a human owns, including applying a theme, creating a
Table over their range, or adding banding, needs `force` and a stated reason.
The guard hook will stop you first. That is the design working.

`references/existing-sheets.md` covers adopting an existing tracker.

## Reading `sheets_check`

The shape mirrors a recalculation report: `status`, `total_formulas`,
`total_errors`, an `error_summary` keyed on the Sheets error types (`REF`,
`NAME`, `VALUE`, `DIVIDE_BY_ZERO`, `N_A`, `NUM`, `NULL_VALUE`, `ERROR`), and
severity-tagged findings that each carry a `fix` string naming the call that
resolves them.

`status: "pending"` means formulas were still calculating (`LOADING`), not that
the sheet is clean. Wait and run it again. `status: "errors_found"` is a stop.

A render is truthful about formatting, with two exceptions. It paints fills,
fonts, borders, banding, merges, column widths, and conditional-format rules,
including a rule whose format is a font change rather than a fill, and a frozen
header repeats on every page. Trust your eyes on all of that, and on layout:
truncated columns, awkward wraps, illegible contrast, a header that does not
look like a header.

**Dropdowns never render as pills.** What you see depends on who made the rule,
and the difference is useful:

- A rule **the API created** shows as plain black text. No pill, no arrow, no
  color, whether it came from a Table column typed `DROPDOWN` or from
  `sheets_validation`.
- A rule **a person colored by hand** shows as colored text, still with no pill.

So a render can confirm that somebody's chip colors are still there, which is
worth checking after any work near their dropdowns. It can never confirm that a
rule exists, because an intact API-created dropdown looks exactly like no rule
at all. `sheets_check` is authoritative for validation state. Confirm a dropdown
there, and never re-create one because the picture looked bare: re-creating it
is what destroys the colors.

**A cell note renders as a footnote.** The export appends a bracketed marker to
the cell's text and lists the note bodies on an extra page after the grid. So a
header reading `Student` comes back as `Student [1]`, a row of ten documented
headers runs on to `Check [10]`, and the tab renders one page more than its grid
needs.

Nothing is wrong with the sheet. The cells hold the plain names, and the marker
is the export doing what a printed document does with a footnote. Since this
guide asks you to put a note on every header, **the sheets you build best are
exactly the ones whose renders read oddly.** Never rewrite a header to remove a
bracket, and never treat the extra page as overflow.

Read that last page. It is the documentation, and it is the only way to see what
a note says without spending another call. The markers are how a render shows
you that documentation exists at all.

Both exceptions point the same way. **A render is for your own eyes.** Use it to
check your own work, where a bracket costs nothing. Anything going in front of a
person should be a browser screenshot, which is what a colleague actually sees.

## References

Load one when you need it. They are one level deep and none of them is required
reading for a routine write.

- `references/style-guide.md`: the ten rules with their sources and the
  reasoning behind each one.
- `references/formulas.md`: lookup patterns, `LET` layout, what to do instead of
  nesting, and the verified-versus-convention split.
- `references/presets.md`: preset schema, how theme slots compile, and how to
  author a house preset.
- `references/lint-rules.md`: every rule `sheets_check` runs, its severity, and
  its fix.
- `references/existing-sheets.md`: adopting, matching conventions, and the
  registry file.
- `references/limitations.md`: what this plugin cannot do, stated plainly.

## Worked examples

Two full transcripts, showing the actual calls in order:

- `examples/roster-tracker.md`: a shared tracker with a Settings tab, a native
  Table, dropdown status, a computed fee, and a self-checking Check column.
- `examples/budget.md`: a three-tab budget where every assumption is a named
  input with a cited source, including the moment the lint catches a magic
  number and what the fix looks like.

Read one before your first build of that shape. They are shorter than the
mistakes they prevent.
