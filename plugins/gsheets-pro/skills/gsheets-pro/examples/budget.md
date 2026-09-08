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

`spreadsheet_id` is on every call, written once and elided after that.

---

## 1. Create it, then apply the preset

```json
sheets_open {
  "create": {
    "title": "Rivermill lesson program: spring budget",
    "tabs": ["Assumptions", "Lines", "Summary"]
  }
}
```

Returns `spreadsheet_id: "1EXAMPLEbudg3tW0rkb00kSyntheticId0002"`.

```json
sheets_style {
  "spreadsheet_id": "1EXAMPLEbudg3tW0rkb00kSyntheticId0002",
  "preset": "finance-classic",
  "archetype": "model"
}
```

No range, so this writes the workbook theme and records both the preset and the
archetype. `model` turns banding off and turns the font-color language on: blue
for a typed input, black for a formula on this sheet, green for one reading
another tab.

## 2. Every assumption, with its source

Four blocks down the Assumptions tab. A block with a title puts its first data
row two below its anchor, and lays out label, value, unit, source across four
columns.

```json
sheets_settings {
  "sheet": "Assumptions",
  "at": "A1",
  "title": "Program",
  "items": [
    { "label": "Financial aid rate", "value": 0.256, "unit": "% of revenue", "format": "percent",
      "name": "Aid_Rate",
      "source": "Last full year's actual, from the finance office." },
    { "label": "Annual overhead", "value": 11460, "unit": "$ per year", "format": "currency",
      "name": "Overhead_Annual",
      "source": "Allocated administrative cost, finance office, this year's figure." },
    { "label": "Weeks in term", "value": 16, "unit": "weeks", "format": "integer",
      "name": "Weeks_Term",
      "source": "Spring term calendar, sixteen teaching weeks." }
  ]
}
```

`0.256`, not `25.6`. Percentages are stored as fractions and the `percent`
format renders them. Storing `25.6` would render `2560.0%`, and the mistake is
easy to miss because the formula bar looks right.

Each item names its own value cell, so `Aid_Rate` and `Overhead_Annual` are
usable from any tab.

Then the two lookup tables. These need a name spanning a whole column on each
side, which is a separate action from writing the block.

```json
sheets_settings {
  "sheet": "Assumptions",
  "at": "A7",
  "title": "What families pay",
  "items": [
    { "label": "30", "value": 80,  "unit": "$ per lesson", "format": "currency",
      "named": false, "source": "Published term rate." },
    { "label": "45", "value": 120, "unit": "$ per lesson", "format": "currency",
      "named": false, "source": "Published term rate." },
    { "label": "60", "value": 160, "unit": "$ per lesson", "format": "currency",
      "named": false, "source": "Published term rate." }
  ]
}
```

`named: false` on every row, because these cells are reached through the pair
below rather than one at a time, and three stray names would be clutter.

```json
sheets_settings { "action": "add_named_range", "sheet": "Assumptions",
                  "name": "Rate_Length",    "range": "A9:A11" }
```

```json
sheets_settings { "action": "add_named_range", "sheet": "Assumptions",
                  "name": "Rate_PerLesson", "range": "B9:B11" }
```

```json
sheets_settings {
  "sheet": "Assumptions",
  "at": "A13",
  "title": "What teachers cost",
  "items": [
    { "label": "Bellweather Studio 30", "value": 65,   "unit": "$ per lesson", "format": "currency",
      "named": false, "source": "Studio contract rate, current agreement." },
    { "label": "Bellweather Studio 45", "value": 97.5, "unit": "$ per lesson", "format": "currency",
      "named": false, "source": "Studio contract rate, current agreement." },
    { "label": "Bellweather Studio 60", "value": 130,  "unit": "$ per lesson", "format": "currency",
      "named": false, "source": "Studio contract rate, current agreement." },
    { "label": "In house 30", "value": 53,   "unit": "$ per lesson", "format": "currency",
      "named": false, "source": "Hourly rate for staff teachers, prorated." },
    { "label": "In house 45", "value": 79.5, "unit": "$ per lesson", "format": "currency",
      "named": false, "source": "Hourly rate for staff teachers, prorated." },
    { "label": "In house 60", "value": 106,  "unit": "$ per lesson", "format": "currency",
      "named": false, "source": "Hourly rate for staff teachers, prorated." }
  ]
}
```

```json
sheets_settings { "action": "add_named_range", "sheet": "Assumptions",
                  "name": "Cost_Key",        "range": "A15:A20" }
```

```json
sheets_settings { "action": "add_named_range", "sheet": "Assumptions",
                  "name": "Cost_PerLesson",  "range": "B15:B20" }
```

The key is `"Bellweather Studio 30"` rather than two separate columns, so one
`XLOOKUP` does what would otherwise need an index and match pair. A composite
key is worth it when the alternative is a formula nobody can read.

## 3. The working lines

```json
sheets_table {
  "sheet": "Lines",
  "action": "create",
  "name": "Lines",
  "range": "A1:I20",
  "columns": [
    { "name": "Teacher", "type": "TEXT", "role": "key", "owner": "human" },
    { "name": "Source", "type": "DROPDOWN", "options": ["Bellweather Studio", "In house"],
      "role": "input", "owner": "human",
      "note": "Where the teacher comes from. This decides who carries the aid cost." },
    { "name": "Length", "type": "DROPDOWN", "options": ["30", "45", "60"],
      "role": "input", "owner": "human", "note": "Minutes per lesson." },
    { "name": "Students", "type": "DOUBLE", "role": "input", "owner": "human",
      "note": "Head count for this teacher this term." },
    { "name": "Lessons", "type": "DOUBLE", "role": "formula", "owner": "agent",
      "note": "Weeks in term, from Assumptions." },
    { "name": "Revenue", "type": "CURRENCY", "role": "formula", "owner": "agent" },
    { "name": "Teacher cost", "type": "CURRENCY", "role": "formula", "owner": "agent" },
    { "name": "Aid we carry", "type": "CURRENCY", "role": "formula", "owner": "agent",
      "note": "Bellweather splits the aid cost with us. In-house teachers, we carry all of it." },
    { "name": "Margin", "type": "CURRENCY", "role": "formula", "owner": "agent" }
  ],
  "freeze_header": true,
  "status_fill_rules": false
}
```

Four input columns, five computed. In the `model` archetype the input columns
render blue and the computed ones black, so which is which is visible without
clicking a cell. `status_fill_rules` is off: neither dropdown here is a status,
and painting `Source` would put a status color language on a column that is not
about status.

## 4. Fill the columns

Each `fill` names a bounded single-column range and one formula for its first
row.

```json
sheets_write { "sheet": "Lines", "mode": "fill", "range": "E2:E20",
               "formula": "=Weeks_Term" }
```

```json
sheets_write { "sheet": "Lines", "mode": "fill", "range": "F2:F20",
               "formula": "=LET(\n  rate, XLOOKUP($C2 & \"\", Rate_Length, Rate_PerLesson, 0),\n  $D2 * $E2 * rate\n)" }
```

```json
sheets_write { "sheet": "Lines", "mode": "fill", "range": "G2:G20",
               "formula": "=LET(\n  key, $B2 & \" \" & $C2,\n  per_lesson, XLOOKUP(key, Cost_Key, Cost_PerLesson, 0),\n  $D2 * $E2 * per_lesson\n)" }
```

The composite key is built once, named `key`, and used once. Without `LET` that
concatenation appears twice in the formula and somebody eventually edits one
copy.

Note the `& ""` in the revenue formula. The `Length` dropdown stores 30, 45 and
60 as numbers while the labels in `Rate_Length` are text, so an uncoerced
comparison matches nothing and returns the fallback. That would give a clean
lint over an empty column, which is the worst kind of wrong.

Now the one that goes wrong for a different reason:

```json
sheets_write { "sheet": "Lines", "mode": "fill", "range": "H2:H20",
               "formula": "=LET(\n  our_share, IF($B2=\"Bellweather Studio\", 0.5, 1),\n  $F2 * Aid_Rate * our_share\n)" }
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
      "location": "Lines!H2:H20",
      "message": "The literal 0.5 appears inside a formula. A split that could change belongs in a named input cell.",
      "fix": "sheets_settings to add the value, then reference it by name"
    }
  ]
}
```

The error gate was always going to pass. `0.5` is a perfectly valid number. What
it is not is a documented decision: somebody agreed to a fifty-fifty split at
some point, and right now the only record of that agreement is three characters
buried in a formula. The day the studio renegotiates, whoever opens this file has
to read the formulas to find it.

The fix is a fourth block and a re-fill:

```json
sheets_settings {
  "sheet": "Assumptions",
  "at": "A22",
  "title": "Studio agreement",
  "items": [
    { "label": "Our share of studio aid", "value": 0.5, "unit": "% of aid cost",
      "format": "percent", "name": "Aid_Share_Studio",
      "source": "Fifty-fifty split with Bellweather Studio, no ceiling. Current agreement." }
  ]
}
```

```json
sheets_write { "sheet": "Lines", "mode": "fill", "range": "H2:H20",
               "formula": "=LET(\n  our_share, IF($B2=\"Bellweather Studio\", Aid_Share_Studio, 1),\n  $F2 * Aid_Rate * our_share\n)" }
```

The sheet now computes the same number and also says why.

```json
sheets_write { "sheet": "Lines", "mode": "fill", "range": "I2:I20",
               "formula": "=$F2 - $G2 - $H2" }
```

Short and plain. Not everything wants a `LET`.

## 6. The summary

```json
sheets_write {
  "sheet": "Summary",
  "mode": "range",
  "range": "A1:B7",
  "values": [
    ["Spring lesson program", ""],
    ["", ""],
    ["Revenue",                 "=SUM(Lines[Revenue])"],
    ["Teacher cost",            "=SUM(Lines[Teacher cost])"],
    ["Financial aid we carry",  "=SUM(Lines[Aid we carry])"],
    ["Margin before overhead",  "=SUM(Lines[Margin])"],
    ["Margin after overhead",   "=SUM(Lines[Margin]) - Overhead_Annual"]
  ]
}
```

Structured references throughout, so adding a teacher to `Lines` updates every
line here with nothing to rerun.

```json
sheets_style {
  "sheet": "Summary",
  "range": "B3:B7",
  "style": { "role": "cross_sheet", "number_format": "currency" }
}
```

The style properties go in one `style` object, and only the ones named are
touched. Green, because these formulas read another tab. That is the whole
convention: a reviewer glancing at `Summary` sees green and knows nothing was
typed here.

```json
sheets_conditional_format {
  "sheet": "Summary",
  "action": "add",
  "ranges": ["B7"],
  "kind": "boolean",
  "operator": "less_than",
  "value": 0,
  "format": { "fill": "flag" }
}
```

The `flag` token, a muted brick. Not alarm red. A negative margin is
information, not an emergency, and a budget that shouts at its reader gets
trusted less, not more.

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

Read the image. Check that the currency column is wide enough, that no cell
shows `###`, and that the labels are not truncated. Then stop.

## The reviewer pass

A budget somebody will make a decision on is worth a second pair of eyes:

```
/gsheets-pro:review the spring budget
```

That forks a reviewer with no memory of this build. It re-reads the formulas,
re-checks the numbers, looks at the renders, and returns a punch list. The author
sees what they meant; the reviewer sees what is in the cells. On a document that
decides whether a program runs, the difference is worth one extra call.
