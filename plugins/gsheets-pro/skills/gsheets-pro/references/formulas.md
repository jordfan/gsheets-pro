# Formulas

How to write a formula somebody else can read six months from now.

Formulas pass through this plugin byte for byte. Nothing here is enforced by
rewriting what you wrote; the lint flags patterns and you decide. The plugin
never rewrites a formula a colleague wrote, ever.

## Lookups

**`XLOOKUP` is the default.** It defaults to exact match, the result range does
not have to sit to the right of the lookup range, and it takes a
`missing_value` argument so a miss returns something sensible instead of `#N/A`.

```
=XLOOKUP(D4, Teacher_Key, Teacher_Lessons, "")
```

That fourth argument is the whole point. It replaces the
`IFERROR(VLOOKUP(...), "")` construction, which is worse in two ways: it hides
every error rather than the one you expected, and it computes the lookup twice
on the failure path.

**`IFNA`, not `IFERROR`, when you do need a wrapper.** `IFNA` catches a failed
lookup and nothing else. `IFERROR` swallows `#REF`, `#VALUE`, `#DIV/0`, and
every genuine bug you have not found yet, and it makes the sheet look healthy
while it does. Lint rule L07 flags `IFERROR`.

**`VLOOKUP` only when matching an existing sheet that uses it.** Rule 9 wins.

## Named ranges and structured references

A bare `$B$2` tells the next reader nothing and breaks quietly when a row is
inserted above it. Both alternatives self-document and survive structural edits.

- **Structured reference** for a whole-column aggregate inside a Table:
  `=SUM(Roster[Fee])`, `=COUNTIF(Roster[Status], "Confirmed")`.
- **Plain relative reference** for a same-row cell inside a Table: `=E4*F4`.
  This stays identical down the column, which is what rule 3 asks for. Whether
  Google honors an Excel-style this-row selector is not verified, so the plugin
  does not generate one.
- **Named range** for anything crossing tabs. `Aid_Rate` beats
  `'Assumptions Inputs'!$B$5`, and a sheet name containing a space needs
  quoting anyway or the reference fails.

Naming: underscores, no spaces, and a name that says what the thing is rather
than where it lives. `Rate_PerLesson`, not `AssumpB5`. A `LET` or `LAMBDA` name
cannot be a bare cell reference like `A1`, cannot start with a digit, and allows
no special characters except dot and underscore.

## `LET`, and how to lay it out

`LET(name, value, [name, value, ...], calculation)` names an intermediate value
inside one formula, so a sub-expression used three times is written once,
evaluated once, and read by a descriptive name. It is the closest thing a
spreadsheet has to a local variable.

**Newlines inside a formula are allowed and do not affect evaluation.** In the
Sheets interface you insert one with Ctrl+Enter, or Cmd+Return on a Mac. Written
through the API, a literal newline in the formula string persists. So a `LET`
past two clauses gets real lines and two-space indentation:

```
=LET(
  lessons, IF(I4<>"", I4, G4),
  rate, XLOOKUP(E4, Rate_Length, Rate_PerLesson, 0),
  inactive, OR(F4="Withdrawn", F4="Declined"),
  IF(OR(inactive, lessons=""), "", rate * lessons)
)
```

Most people never do this, which is exactly why it is worth doing. The one-line
version of that formula is 140 characters of parentheses and nobody checks it.

Verification note: newline persistence through `USER_ENTERED` writes is
confirmed by the Sheets interface behavior and by independent documentation, and
is on the project's spike list to confirm against the API directly. If a build
comes back with the newlines collapsed, fall back to a single-line `LET`. The
named clauses still carry most of the readability.

## What not to put in a formula

**No magic numbers.** ICAEW #14. Any literal that could ever change belongs in a
named input cell with a note. A `0.5` inside a formula is a decision nobody
recorded. Rates, thresholds, splits, cutoff dates: all inputs.

Literals that are fine: `0`, `1`, `-1`, and positional arguments such as the
column index in `INDEX` or the digit count in `ROUND`. Lint rule L06 knows the
difference.

**No repeated sub-expression.** ICAEW #15. If the same lookup appears twice in
one formula, name it with `LET`. If it appears in two formulas, it wants to be a
helper column.

**No deep nesting.** Past about four levels, split it. `references/style-guide.md`
rule 4 has the argument.

## Number formats

Percentages are **stored as fractions**. `0.256` with a `0.0%` format renders
`25.6%`. Storing `25.6` renders `2560.0%`, which the lint catches as L13 and
which is otherwise easy to miss because the number looks right in the formula
bar.

Currency uses the preset's pattern, which puts negatives in parentheses and
renders zero as a dash rather than `$0`:

```
"$"#,##0;("$"#,##0);"-"
```

Name the unit in the header, not in every cell. `Revenue ($ thousands)` beats
1,200 cells each carrying a suffix.

Years are plain integers or text. `2026`, never `2,026`. Lint rule L19.

Dates use one format across the whole spreadsheet. `yyyy-mm-dd` sorts correctly
as text, is unambiguous internationally, and is the preset default.

## A check column

A tracker earns its keep when it tells you what is wrong with it. One column,
usually last, holding a formula that returns a blank when the row is fine and a
plain-language problem when it is not:

```
=LET(
  no_length, E4="",
  no_teacher, D4="",
  TEXTJOIN("; ", TRUE,
    IF(no_length, "Length missing", ""),
    IF(no_teacher, "Teacher missing", ""))
)
```

Add a conditional format so a non-blank Check paints the `flag` fill, and a note
on the header saying to resolve the flags rather than delete the column.

This is worth more than it looks. It moves data quality from something a person
audits occasionally to something the sheet reports continuously, to whoever is
looking, including a colleague who has never heard of this plugin.

## What is verified and what is convention

- **Verified against Google's documentation:** `XLOOKUP` argument order and
  `missing_value` behavior, `LET` semantics, the `LAMBDA` helper family
  (`MAP`, `REDUCE`, `BYROW`, `BYCOL`, `SCAN`, `MAKEARRAY`), name restrictions,
  Table structured references and their auto-expansion, and Table naming rules.
- **Verified by consensus rather than a primary source:** newlines inside a
  formula being purely cosmetic, and the trailing-comma trick in a custom number
  format that scales a display by a thousand.
- **Convention, argued rather than documented:** `IFNA` over `IFERROR`, the
  nesting depth at which to split, and the `LET` indentation style. These come
  from the FAST and ICAEW standards and from modelling practice, not from a
  Google document.

A rule in the second or third category is still a good rule. It is just not one
to cite as though Google published it.
