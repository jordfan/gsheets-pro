# Worked example: a budget with assumptions

The other shape. A tracker is maintained; a budget is argued with. Its first
reader always asks the same question, which is which of these numbers were
assumed, so the whole build is arranged to answer that before it is asked.

Every name, number, and identifier here is invented.

**The request.** "Work out whether the spring lesson program covers its costs.
We charge families per lesson, we pay teachers per lesson, some teachers come
through an outside studio that splits the financial-aid cost with us, and there
is an annual overhead figure to cover."

**The read.** This is a `model`, not a tracker. Nobody maintains it week to
week. It gets built, reviewed, and argued about, so `finance-classic` is the
right preset: a reviewer already knows that blue means somebody typed it.

**The plan.** Three tabs, in the order ICAEW asks for. `Assumptions` holds
inputs and nothing else. `Lines` holds one row per teacher and does the work.
`Summary` holds the four numbers anybody actually quotes.

---

## 1. Create it

```json
sheets_open {
  "create": {
    "title": "Rivermill lesson program: spring budget",
    "preset": "finance-classic",
    "archetype": "model",
    "tabs": [
      { "name": "Assumptions", "role": "inputs" },
      { "name": "Lines",       "role": "workings" },
      { "name": "Summary",     "role": "outputs" }
    ]
  }
}
```

Returns `spreadsheet_id: "1EXAMPLEbudg3tW0rkb00kSyntheticId0002"`, elided below.

`archetype: "model"` turns banding off and turns the font-color language on.
Blue for a typed input, black for a formula on this sheet, green for one reading
another tab. The tab colors already separate inputs from workings from outputs
before anyone clicks anything.

## 2. Every assumption, with its source

```json
sheets_settings {
  "sheet": "Assumptions",
  "block": "Program",
  "rows": [
    { "label": "Financial aid rate", "value": 0.256, "unit": "% of revenue",
      "format": "percent",
      "note": "Last full year's actual, from the finance office." },
    { "label": "Annual overhead", "value": 11460, "unit": "$ per year",
      "format": "currency",
      "note": "Allocated administrative cost, finance office, this year's figure." },
    { "label": "Weeks in term", "value": 16, "unit": "weeks",
      "note": "Spring term calendar, sixteen teaching weeks." }
  ],
  "names": { "key": "Program_Key", "value": "Program_Value" },
  "individual_names": {
    "Financial aid rate": "Aid_Rate",
    "Annual overhead": "Overhead_Annual",
    "Weeks in term": "Weeks_Term"
  }
}
```

`0.256`, not `25.6`. Percentages are stored as fractions and the `percent`
format renders them. Storing `25.6` would render `2560.0%`, and the mistake is
easy to miss because the formula bar looks right.

`individual_names` gives each row its own named range as well as the lookup
pair, because these three get referenced by name across tabs.

Then the two lookup tables:

```json
sheets_settings {
  "sheet": "Assumptions",
  "block": "What families pay",
  "rows": [
    { "label": "30 minutes", "value": 80,  "unit": "$ per lesson", "format": "currency",
      "note": "Published term rate." },
    { "label": "45 minutes", "value": 120, "unit": "$ per lesson", "format": "currency",
      "note": "Published term rate." },
    { "label": "60 minutes", "value": 160, "unit": "$ per lesson", "format": "currency",
      "note": "Published term rate." }
  ],
  "names": { "key": "Rate_Length", "value": "Rate_PerLesson" }
}
```

```json
sheets_settings {
  "sheet": "Assumptions",
  "block": "What teachers cost",
  "rows": [
    { "label": "Bellweather Studio 30", "value": 65,   "unit": "$ per lesson", "format": "currency",
      "note": "Studio contract rate, current agreement." },
    { "label": "Bellweather Studio 45", "value": 97.5, "unit": "$ per lesson", "format": "currency",
      "note": "Studio contract rate, current agreement." },
    { "label": "Bellweather Studio 60", "value": 130,  "unit": "$ per lesson", "format": "currency",
      "note": "Studio contract rate, current agreement." },
    { "label": "In house 30", "value": 53,  "unit": "$ per lesson", "format": "currency",
      "note": "Hourly rate for staff teachers, prorated." },
    { "label": "In house 45", "value": 79.5, "unit": "$ per lesson", "format": "currency",
      "note": "Hourly rate for staff teachers, prorated." },
    { "label": "In house 60", "value": 106, "unit": "$ per lesson", "format": "currency",
      "note": "Hourly rate for staff teachers, prorated." }
  ],
  "names": { "key": "Cost_Key", "value": "Cost_PerLesson" }
}
```

The key is `"Bellweather Studio 30"` rather than two separate columns, so one
`XLOOKUP` does what would otherwise need an index and match pair. Composite keys
are worth it when the alternative is a formula nobody can read.

## 3. The working lines

```json
sheets_table {
  "action": "create",
  "sheet": "Lines",
  "name": "Lines",
  "anchor": "A3",
  "title": "One row per teacher",
  "freeze_header": true,
  "columns": [
    { "name": "Teacher", "type": "TEXT", "key": true },
    { "name": "Source", "type": "DROPDOWN", "options": ["Bellweather Studio", "In house"],
      "role": "input",
      "help": "Where the teacher comes from. This decides who carries the aid cost." },
    { "name": "Length", "type": "DROPDOWN", "options": ["30", "45", "60"], "role": "input",
      "help": "Minutes per lesson." },
    { "name": "Students", "type": "DOUBLE", "role": "input",
      "note": "Head count for this teacher this term." },
    { "name": "Lessons", "type": "DOUBLE", "role": "formula",
      "note": "Weeks in term, from Assumptions." },
    { "name": "Revenue", "type": "CURRENCY", "role": "formula" },
    { "name": "Teacher cost", "type": "CURRENCY", "role": "formula" },
    { "name": "Aid we carry", "type": "CURRENCY", "role": "formula",
      "note": "Bellweather splits the aid cost with us. In-house teachers, we carry all of it." },
    { "name": "Margin", "type": "CURRENCY", "role": "formula" }
  ]
}
```

Four input columns, five computed. In the `model` archetype the input columns
render blue and the computed ones black, so which is which is visible without
clicking a cell.

## 4. Fill the columns

```json
sheets_write { "mode": "fill", "table": "Lines", "column": "Lessons",
  "formula": "=Weeks_Term" }
```

```json
sheets_write { "mode": "fill", "table": "Lines", "column": "Revenue",
  "formula": "=LET(\n  rate, XLOOKUP($C4, Rate_Length, Rate_PerLesson, 0),\n  $D4 * $E4 * rate\n)" }
```

```json
sheets_write { "mode": "fill", "table": "Lines", "column": "Teacher cost",
  "formula": "=LET(\n  key, $B4 & \" \" & $C4,\n  per_lesson, XLOOKUP(key, Cost_Key, Cost_PerLesson, 0),\n  $D4 * $E4 * per_lesson\n)" }
```

The composite key is built once, named `key`, and used once. Without `LET` that
concatenation appears twice in the formula and somebody eventually edits one
copy.

Now the one that goes wrong:

```json
sheets_write { "mode": "fill", "table": "Lines", "column": "Aid we carry",
  "formula": "=LET(\n  our_share, IF($B4=\"Bellweather Studio\", 0.5, 1),\n  $F4 * Aid_Rate * our_share\n)" }
```

Returns `check: { status: "success", total_errors: 0 }`. It evaluates fine.

## 5. The lint catches what the gate cannot

```json
sheets_check { "sheets": ["Assumptions", "Lines", "Summary"] }
```

```json
{
  "status": "success",
  "total_formulas": 41,
  "total_errors": 0,
  "findings": [
    {
      "rule": "L06",
      "severity": "warning",
      "location": "Lines!H4:H9",
      "message": "The literal 0.5 appears inside a formula. A split that could change belongs in a named input cell.",
      "fix": "sheets_settings to add the value, then reference it by name"
    }
  ]
}
```

The error gate was always going to pass. `0.5` is a perfectly valid number. What
it is not is a documented decision: somebody agreed to a fifty-fifty split at
some point, and right now the only record of that agreement is six characters
buried in a formula. The day the studio renegotiates, whoever opens this file
has to read the formulas to find it.

The fix:

```json
sheets_settings {
  "sheet": "Assumptions",
  "block": "Program",
  "append": true,
  "rows": [
    { "label": "Our share of studio aid", "value": 0.5, "unit": "% of aid cost",
      "format": "percent",
      "note": "Fifty-fifty split with Bellweather Studio, no ceiling. Current agreement." }
  ],
  "individual_names": { "Our share of studio aid": "Aid_Share_Studio" }
}
```

```json
sheets_write { "mode": "fill", "table": "Lines", "column": "Aid we carry",
  "formula": "=LET(\n  our_share, IF($B4=\"Bellweather Studio\", Aid_Share_Studio, 1),\n  $F4 * Aid_Rate * our_share\n)" }
```

The sheet now computes the same number and also says why.

```json
sheets_write { "mode": "fill", "table": "Lines", "column": "Margin",
  "formula": "=$F4 - $G4 - $H4" }
```

Short and plain. Not everything wants a `LET`.

## 6. The summary

```json
sheets_write {
  "mode": "range",
  "sheet": "Summary",
  "range": "A1:B7",
  "values": [
    ["Spring lesson program", ""],
    ["", ""],
    ["Revenue",              "=SUM(Lines[Revenue])"],
    ["Teacher cost",         "=SUM(Lines[Teacher cost])"],
    ["Financial aid we carry", "=SUM(Lines[Aid we carry])"],
    ["Margin before overhead", "=SUM(Lines[Margin])"],
    ["Margin after overhead",  "=SUM(Lines[Margin]) - Overhead_Annual"]
  ]
}
```

Structured references throughout, so adding a teacher to `Lines` updates every
line here with nothing to rerun.

```json
sheets_style {
  "sheet": "Summary",
  "range": "B3:B7",
  "role": "cross_sheet",
  "number_format": "currency"
}
```

Green, because these formulas read another tab. That is the whole convention: a
reviewer glancing at `Summary` sees green and knows nothing was typed here.

```json
sheets_conditional_format {
  "action": "add",
  "sheet": "Summary",
  "range": "B7",
  "condition": { "type": "NUMBER_LESS", "value": 0 },
  "fill": "flag"
}
```

The `flag` token, a muted brick. Not alarm red. A negative margin is information,
not an emergency, and a budget that shouts at its reader gets trusted less, not
more.

## 7. Verify, check by hand, look

```json
sheets_check { "sheets": ["Assumptions", "Lines", "Summary"] }
```

```json
{ "status": "success", "total_formulas": 48, "total_errors": 0, "findings": [] }
```

Then the step the lint cannot do. Take one row and work it out on paper. A
Bellweather teacher at 45 minutes with 6 students: revenue is 6 times 16 lessons
times $120, so $11,520. Cost is 6 times 16 times $97.50, so $9,360. Aid is
$11,520 times 0.256 times 0.5, so $1,474.56. Margin $685.44. Read those four
cells back and confirm.

If they match, the formulas point where you think they do. If they do not, the
lint would never have told you, because every one of those formulas evaluates
perfectly whether or not it is looking at the right column.

```json
sheets_render { "sheet": "Summary" }
```

Read the image at `pages[0].path`. Check that the currency column is wide
enough, that no cell shows `###`, and that the labels are not truncated. Then
stop.

## The reviewer pass

A budget somebody will make a decision on is worth a second pair of eyes:

```
/gsheets-pro:review the spring budget
```

That forks a reviewer with no memory of this build. It re-reads the formulas,
re-checks the numbers, looks at the renders, and returns a punch list. The
author sees what they meant; the reviewer sees what is in the cells. On a
document that decides whether a program runs, the difference is worth one extra
call.
