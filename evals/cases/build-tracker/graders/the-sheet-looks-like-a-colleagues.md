---
type: llm
name: the-sheet-looks-like-a-colleagues
focus:
  source: file
  path: shifts.png
weight: 3
arm: with-only
---
You are looking at a picture of a finished spreadsheet tab. Judge only what is
visible. This is a render, so dropdowns never appear as coloured pills even when
they exist: do not mark the sheet down for that, and do not treat a plain-looking
cell as a missing dropdown.

The sheet passes if a careful colleague would accept it as their own work. All of
these must hold.

1. There is a header row that reads as a header: distinct fill or weight, one
   short label per column, and it sits above the data rather than floating.
2. Every column is wide enough for what is in it. No truncated names, no `###`,
   no email address running under the next column, no awkward mid-word wrap.
3. The money column reads as money and is consistent down its whole length: one
   currency style, one number of decimal places. No raw floats like `112.00000`
   and no bare integers mixed in with formatted ones.
4. Text is legible against whatever is behind it. No dark text on a dark fill,
   no pale grey on white, nothing where you have to squint.
5. The rows line up as one table. No stray blank row inside the data, no cell
   that is obviously merged across a data region, no second block of unrelated
   content wedged into the same columns.
6. Status is carried by words a person can read, not only by colour. If a row is
   flagged or shaded, the row also says in text what state it is in.

Fail it if any of the six is clearly violated. Do not fail it for taste: an
unexciting palette, a font you would not have picked, or a column order you would
have chosen differently are all fine. Say which of the six failed and point at
where in the image you saw it.
