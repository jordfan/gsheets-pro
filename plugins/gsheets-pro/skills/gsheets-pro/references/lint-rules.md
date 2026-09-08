# Lint rules

What `sheets_check` looks for, what each severity means, and the fix.

## The output shape

```json
{
  "status": "success",
  "total_formulas": 214,
  "total_errors": 0,
  "error_summary": {},
  "findings": [
    {
      "rule": "L09",
      "severity": "warning",
      "location": "Roster!A1:J1",
      "message": "The Roster tab has a Table but no frozen header row.",
      "fix": "sheets_style with sheet: \"Roster\", freeze_rows: 1"
    }
  ]
}
```

`error_summary` is keyed on the Sheets error types, which are locale
independent: `ERROR`, `NULL_VALUE`, `DIVIDE_BY_ZERO`, `VALUE`, `REF`, `NAME`,
`NUM`, `N_A`, `LOADING`. Each entry carries a count, up to a hundred locations,
and how many locations were truncated.

The `check` a write returns carries the same fields with a smaller summary: it
counts by error type and names the offending cells in its own `cells` list,
because it covers the range one call touched rather than a whole spreadsheet.

The statuses, shared by the lint and by every write's `check`:

- **`success`** means no error-severity finding. Warnings may still be present.
- **`errors_found`** means at least one. This is a stop.
- **`pending`** means cells were still calculating when the check ran. The tool
  retries with backoff for about five seconds first, so `pending` means they are
  genuinely slow, not that the sheet is clean. Wait and run it again.
- **`skipped`** means the check did not run: nothing was touched that could be
  read back, or the call passed `check: false`. It is not a clean bill of
  health, and the `note` says which of the two it was. Only a write reports it.
  `sheets_check` always reads, so it never returns `skipped`.

The tool call succeeding is not the sheet being clean. Read `status`.

## Severities

**error.** Something is wrong with the spreadsheet. Do not call the work done.
If you believe the error predates your change, prove it by reading that cell
rather than assuming.

**warning.** Something a careful person would have done differently. Fix it, or
say in one sentence why you left it. Leaving a warning unexplained is how a
lint stops being read.

**info.** A polish item. Clear these on a sheet you built. Do not go clearing
them on somebody else's sheet you were asked to append a row to.

## The rules in v1

| Rule | Severity | What it catches | The fix |
|---|---|---|---|
| **L01** formula error | error | A cell whose evaluated value is an `errorValue`. `LOADING` is retried before it counts | Read the cell, find the broken reference, repair the formula |
| **L04** merge in a data region | error | A merged range overlapping a Table, a formula block, or a header row. Merges break sorting, filtering, and formulas that cross them | `sheets_style` with `unmerge`, then use centering or a title row above the table |
| **L09** no frozen header | warning | A sheet with a Table or a bold first row and `frozenRowCount` of zero | `sheets_style` with `freeze_rows: 1` |
| **L14** write outside designated columns | warning | A write in this session landed in a column the registry or the sheet's column metadata marks as human owned | Undo it. The column belongs to somebody else, and they will not expect it to have changed |
| **L20** key column blank or duplicated | warning | The column the contract names as the key has an empty cell or a repeated value. Every keyed update depends on it being unique | Fill the blank, or resolve the duplicate. Do not switch to row indexes |
| **L22** check column flags | warning | The sheet's own Check column is non-blank on one or more rows. The spreadsheet is telling you about itself | Resolve what the Check column says. It is usually a missing input rather than a formula bug |
| **L23** text that does not read as a colleague's | warning | Message ids, "agent", "run report", "TODO:", internal status codes, or a bare timestamp in a cell, note, or help text | Rewrite it as a sentence a colleague would write. Per-sheet allowlists exist for a sheet where these words are legitimate content |

L23 matches on patterns, not bare words. A spreadsheet tracking software work
will legitimately contain the word "agent", and a sheet can carry its own
allowlist in the registry. It runs only where somebody other than the writer
reads the text: a sheet the registry marks `human` or `shared`, or one that sets
`colleague_safe_text`. The patterns are the ones `sheets_write` uses to refuse
text before it lands, so the lint is the same check run over a sheet that was
written by hand or by an older tool.

L14 asks what this session did, not what is in the sheet. A value sitting in
somebody else's column proves nothing, because they probably typed it, so the
rule reads the ranges the server recorded itself writing. That record lives in
memory and does not survive a restart. Pass `writes` with A1 ranges to add
writes the server did not make.

## Scoping a check

Everything is optional except the spreadsheet id.

- `sheets`, an array of tab names. Every visible tab when omitted.
- `sheet` and `range`, to narrow to part of one tab.
- `rules`, an array of ids, to run a subset. An id no rule answers to is
  reported in `notes` rather than ignored.

Two reads happen per call: the values, rendered as formulas, which is also how
the tool learns each tab's real extent, and then a masked grid read bounded to
exactly that extent.

## What is not in v1

The full rule set in the design covers roughly twenty checks. Seven ship in v1
because each of them is unambiguous, cheap to compute from one masked read, and
produces a fix that names a specific call. The rest are on the roadmap:

- **L02** inconsistent formula column and **L03** hardcoded value in a formula
  column. Both matter a great deal, and both need reference-vector analysis to
  avoid false positives on a totals row or a deliberate first-row seed. A lint
  that cries wolf on a legitimate exception stops being read, which costs more
  than the rule earns.
- **L05** broken or unused named range, **L06** magic number, **L07** `IFERROR`
  or `VLOOKUP`, **L08** input without a source note.
- **L10** off-theme color, **L11** banned or foreign font, **L12** low contrast.
- **L13** percentage stored as a whole number, **L15** header without a note,
  **L16** dropdown without help text, **L17** gridlines shown alongside banding,
  **L18** orphaned conditional format, **L19** year with a thousands separator,
  **L21** protection missing on a formula column.

Everything on that list is still a rule in `references/style-guide.md`. It is
just not yet machine-checked, which means you are the check.

## What the lint sees that a render does not

Only one thing, but it matters: **a render can never confirm that a dropdown
exists.** No validation rule paints as a pill, and one the API created paints as
plain black text, indistinguishable from a cell carrying no rule at all. So a
bare-looking cell in an image is not evidence that anything is missing. The lint
is authoritative for validation state.

The near miss is worth knowing. A rule **a person colored by hand** paints as
colored text, still with no pill. So an image does tell you whether a
colleague's chip colors survived, even though it cannot tell you whether a rule
is there. Those colors are the fragile thing in the whole system: rewriting the
rule destroys them, and the API cannot read them back to put them right.

Everything else in a render is trustworthy. It paints fills, fonts, borders,
banding, merges, column widths, and conditional-format rules, including rules
whose format is a font change rather than a fill, and a conditional fill
correctly overrides the banding beneath it. A frozen header repeats on every
page.

So the split is narrower than it sounds. Use the render for layout and for
formatting, use the lint for validation state and for everything structural it
can see that no picture shows: formula errors, merges inside a data region, a
key column with duplicates, text that does not read as a colleague's.
