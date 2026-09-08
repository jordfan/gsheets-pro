# The style guide

The ten rules in SKILL.md, with the reasoning and the sources. Read this when a
rule seems wrong for the situation in front of you, because knowing why a rule
exists is what tells you when it does not apply.

Two standards sit behind most of this. The **FAST Standard** for financial
modelling names four pillars: Flexible, Appropriate, Structured, Transparent.
The one that does the work here is Transparent, which asks for "simple, clear
formulas that can be understood by other modellers and non-modellers alike".
The **ICAEW Twenty principles for good spreadsheet practice** supplies the
specific rules, and three of them appear again and again below: separate and
clearly identify inputs, workings, and outputs (#10); never embed in a formula
anything that might change (#14); perform a calculation once and refer back to
it (#15).

## 1. Tabular data is a native Table

Google Sheets Tables shipped in 2024. Converting a range gives you a styled
header, banding, a per-column filter, and a declared type per column. The
feature that matters most is invisible: **structured references**, where
`SUM(Roster[Fee])` addresses a column by name and the range grows on its own as
rows are added.

That is the whole argument. A hand-formatted range with `SUM(H2:H41)` in it is
a spreadsheet that breaks the first time a colleague adds a row at the bottom,
and it breaks silently, which is the worst way for a spreadsheet to break. Since
an agent-maintained sheet is one where rows get added constantly, by both a
person and a script, self-expanding ranges are not a nicety.

Column types worth knowing: Number, Percent, Currency, Date, Time, Dropdown,
Checkbox, and the smart chips (People, File, Place, Rating). Table names cannot
be `TRUE` or `FALSE`, cannot look like a cell address, cannot start with a
digit, and allow no special characters except underscore.

**When it does not apply:** a summary block, a title banner, or an assumptions
list is not tabular data. Do not force those into a Table.

## 2. Inputs live in a Settings block with named ranges and source notes

ICAEW #10 and #14 together. Every number that could change goes in one labelled
cell, gets a named range, and carries a note saying where it came from.

The note is the part people skip, and it is the part that matters in six months.
"Confirmed by the business office, 2026-08-14" or "from the vendor's quote" is
enough. When the number came from whoever asked for the sheet, say that plainly.
A number with no provenance is a number nobody can defend, and the person who has
to defend it is usually not the person who typed it.

`sheets_settings` writes the label, the value, the unit, and the note, creates
the named range, and puts a warning-only protection over the block. Warning-only
is deliberate: a colleague who genuinely needs to change a rate can, and gets a
nudge on the way.

## 3. A formula column is identical down its whole length

ICAEW #12, and the source of more wrong spreadsheets than any other single
thing. One cell in the middle of a column that somebody edited by hand looks
exactly like its neighbours and computes something different. Nothing about the
sheet shows it.

Write the formula once in the first data row, then use `sheets_write` mode
`fill`, which issues an autofill across the column so the API produces the same
consistent series a person's drag-fill would. Lint rules L02 and L03 look for
the outliers.

If one row genuinely is an exception, do not encode the exception in the
formula. Add an override column, name it plainly, and let the formula read it.
The exception becomes visible data instead of a hidden edit.

## 4. Prefer a helper column to a formula nobody can read

FAST's Transparent pillar, in its operative form: break calculations into
separate steps. ICAEW #13 says the same, keep formulas as short as practicable.

In practice: if a formula needs more than about four levels of nesting, or you
find yourself counting parentheses, it wants to be two columns. A helper column
costs one column of width and buys a formula anyone can check. Hide the helper
column if it clutters the view; do not inline it to look clever.

`references/formulas.md` has the lookup patterns and the `LET` layout.

## 5. Fill carries status, font color carries data role, and the two never mix

Two separate color systems that people routinely collide into one unreadable
palette.

**Fill means status.** Applied by a dropdown chip or a conditional format rule,
never painted by hand, because a hand-painted fill is not data. It does not
sort, does not filter, does not survive a row insert, and nothing can count it.

**Font color means data role**, and only in the `model` archetype: blue for a
typed input, black for a formula on this sheet, green for one reading another
tab. This is the Macabacus and Wall Street Prep convention that financial
modellers have used for decades, and its own rule is to reserve color for cells
that illuminate the logic. In the `tracker` archetype the whole system is off:
text is black, and state lives in a Status column with actual words in it.

Both resolve from preset tokens, so a preset change re-skins the sheet.

And color is never the only carrier. A red cell with no label is invisible to a
colorblind reader, unsortable by everyone, and meaningless when printed in black
and white. Pair every color with a value.

## 6. Freeze the header, never merge inside a data region

Freezing is the near-universal first move, and it has a second effect people
miss: File > Print has a Repeat frozen rows option, so the header reprints on
every physical page, but only if an actual freeze exists.

Merged cells break sorting, break filtering, and break most formulas that cross
them. Merge only a title banner above the table body, never a cell inside it.
Lint rule L04 catches merges overlapping a Table or a formula block.

Hide gridlines only when banding or borders already separate the rows. Without
that structure, hiding gridlines makes a sheet harder to read, not cleaner.

**Column widths: autofit the values, fix and wrap the prose, and give a chip
column about half again what autofit gives.** Autofit is right for a column of
short values and wrong for a column of sentences, which it makes wider than the
page, so those get a fixed width and `wrap` instead.

The dropdown exception is the one that catches people. A chip renders with
padding around its text and an arrow beside it, and none of that is in the
string the API measures, so an autofitted dropdown column is reliably too narrow
and clips its longest option in the browser. On the golden sheet autofit gave
about 230 pixels and the column needed 330. Both 240 and 300 still clipped.

Half again is a starting point, not a formula. The shortfall is the padding and
the arrow, which are close to a fixed number of pixels, so as a proportion it
grows with the length of the longest option: a column of short statuses needs
proportionally more than a column of long ones.

**Confirm a chip column in the browser.** Nothing else can see this. The lint
has no rule for it, and a render is worse than useless here, because dropdowns
paint as plain text with no pill at all, so the render shows a column that fits
comfortably while the real sheet clips.

Hand-picking widths for everything else is a losing game. Widening one column
truncates the next, and the next change to the data moves the truncation again.

## 7. Write the documentation into the sheet

Sheets gives you three places, and they are for three different things.

**A note on a header cell** documents the column: what it means, its units,
where its values come from. It shows as a small mark in the corner and a tooltip
on hover. Notes, not comments: comments are threaded discussion that people
resolve and dismiss, and documentation should not be dismissible.

**Validation help text** documents entry: what a valid value looks like. It
appears when somebody clicks the cell, which is the moment they need it.

**An About tab** documents the spreadsheet: what it is for, who owns which
columns, what to do when something looks wrong. One short paragraph.

All three read as one colleague writing to another.

## 8. Never declare done on `errors_found`

Borrowed directly from Anthropic's own xlsx skill, which puts it well: an error
you introduced looks exactly like one you inherited. If you believe an error
predates your change, prove it by reading that cell as it was, rather than
assuming.

The limit of the gate is worth stating too. A green check proves the formulas
evaluate. It does not prove they are right. An off-by-one range or a reference
to the wrong row gives you a perfectly clean sheet with wrong numbers in it.
Write two or three formulas first, read the values back, confirm they pull what
you expect, and only then fill the column.

## 9. An existing spreadsheet's conventions beat this guide

Wholly. Its date format, its fonts, its colors, its column order, its habit of
putting totals at the top. Match all of it, including the parts you would have
done differently.

A sheet somebody else built is a sheet somebody else reads. Consistency with
what is already there is worth more to them than any rule here. See
`references/existing-sheets.md`.

## 10. Text in a shared spreadsheet reads as a colleague wrote it

Everything written into a cell, a note, a help text, or a status label is read
by whoever opens the file, with none of the context you have.

So: no message ids, no ticket references, no "agent", no "run report", no
"TODO:", no internal status vocabulary, no timestamps nobody asked for. A status
that reads "Time confirmed by family" is a status a person understands. One that
reads "STATE_3_CONFIRMED" is not.

This is lint rule L23, which matches on patterns rather than bare words, because
a sheet about a software project may legitimately contain the word "agent". Each
spreadsheet can carry its own allowlist.
