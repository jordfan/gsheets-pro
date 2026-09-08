# Worked example: a roster tracker

A shared tracker built from nothing, in the order the calls actually happen.
Every name, number, and identifier here is invented.

**The request.** "Build me a tracker for next term's private lessons at Rivermill
Community Music. I need to see who is signed up, with which teacher, on what
instrument, how far along we are with each family, and what each one owes."

**The read.** This is a `tracker`: a group of people will maintain it together
over a term, rows get added constantly, and the interesting column is status. It
is not a model, so font color stays out of the data language and state lives in
a Status column with real words in it.

**The plan, in three sentences.** A `Roster` tab holding one row per student, as
a native Table. A `Settings` tab holding the per-length rate and the per-teacher
lesson count, each a named range with a note saying where the number came from.
An `About` tab saying who owns which columns.

Every call takes `spreadsheet_id`. It is written once below and elided after
that, to keep the shapes readable.

---

## 1. Create the spreadsheet, then apply the preset

```json
sheets_open {
  "create": {
    "title": "Rivermill Private Lessons: Spring Term",
    "tabs": ["Roster", "Settings", "About"]
  }
}
```

Returns `spreadsheet_id: "1EXAMPLEr0st3rTrackerSyntheticId000001"` and the three
tabs. `create` takes a title and tab names, nothing else. It does not take a
preset, and tabs carry no role at this point.

The preset is its own call, and **the absence of a range is what makes it a
workbook theme** rather than a style on some cells:

```json
sheets_style {
  "spreadsheet_id": "1EXAMPLEr0st3rTrackerSyntheticId000001",
  "preset": "neutral"
}
```

That writes all nine theme slots and records the preset in the spreadsheet's own
metadata, so every later call resolving a role token knows which palette it
means.

## 2. Write the assumptions before anything that depends on them

A settings block lays out four columns from its anchor: label, value, unit,
source. With a `title`, the title takes the anchor row, a header row follows,
and the data starts two rows below the anchor.

```json
sheets_settings {
  "sheet": "Settings",
  "at": "A1",
  "title": "Lesson rates",
  "items": [
    { "label": "30 minutes", "value": 80, "unit": "$ per lesson", "format": "currency",
      "source": "Term rate, confirmed by the office 2027-01-12.", "name": "Rate_30" },
    { "label": "45 minutes", "value": 120, "unit": "$ per lesson", "format": "currency",
      "source": "Term rate, confirmed by the office 2027-01-12.", "name": "Rate_45" },
    { "label": "60 minutes", "value": 160, "unit": "$ per lesson", "format": "currency",
      "source": "Term rate, confirmed by the office 2027-01-12.", "name": "Rate_60" }
  ]
}
```

Anchored at A1 with a title, the labels land in A3:A5 and the values in B3:B5.
Every value cell gets its own named range from `name`, or from its label when
`name` is omitted.

Those per-cell names are not enough for a lookup, which needs a whole column on
each side. Two more calls make the pair, using the A1 ranges the block just
reported back:

```json
sheets_settings { "action": "add_named_range", "sheet": "Settings",
                  "name": "Rate_Length",    "range": "A3:A5" }
```

```json
sheets_settings { "action": "add_named_range", "sheet": "Settings",
                  "name": "Rate_PerLesson", "range": "B3:B5" }
```

Then the teachers, in a second block below the first:

```json
sheets_settings {
  "sheet": "Settings",
  "at": "A7",
  "title": "Teachers",
  "items": [
    { "label": "N. Okafor", "value": 14, "unit": "lessons this term", "format": "integer",
      "source": "Teaching Tuesdays and Thursdays. Two weeks off in March." },
    { "label": "T. Bright", "value": 16, "unit": "lessons this term", "format": "integer",
      "source": "Full term." },
    { "label": "H. Kerr", "value": 16, "unit": "lessons this term", "format": "integer",
      "source": "Full term." }
  ]
}
```

Anchored at A7, so labels in A9:A11 and values in B9:B11:

```json
sheets_settings { "action": "add_named_range", "sheet": "Settings",
                  "name": "Teacher_Key",     "range": "A9:A11" }
```

```json
sheets_settings { "action": "add_named_range", "sheet": "Settings",
                  "name": "Teacher_Lessons", "range": "B9:B11" }
```

The `source` column is the one everybody skips and later needs. It is why, in
March, "why does one teacher have fourteen" is a cell rather than a
conversation. The tool puts a warning-only protection over each block and colors
the tab as an inputs tab without being asked.

## 3. Build the Table

A Table takes the **whole block including its header row** as a bounded range.
It cannot cover an open range like `A:J`, and it grows on its own as rows are
appended.

```json
sheets_table {
  "sheet": "Roster",
  "action": "create",
  "name": "Roster",
  "range": "A1:J20",
  "columns": [
    { "name": "Student", "type": "TEXT", "role": "key", "owner": "human",
      "note": "Preferred name, as the family writes it." },
    { "name": "Guardian email", "type": "TEXT", "owner": "human",
      "note": "The address term reminders go to." },
    { "name": "Instrument", "type": "TEXT", "owner": "human" },
    { "name": "Teacher", "type": "DROPDOWN", "options_range": "Settings!A9:A11",
      "owner": "human", "note": "The teachers listed on the Settings tab." },
    { "name": "Length", "type": "DROPDOWN", "options": ["30", "45", "60"],
      "owner": "human", "note": "Minutes. Most students take 30." },
    { "name": "Status", "type": "DROPDOWN", "role": "status", "owner": "human",
      "options": [
        "Interest noted, details pending",
        "Details in, time not yet offered",
        "Time offered to family",
        "Time confirmed by family",
        "Waitlisted",
        "Not continuing this term"
      ],
      "note": "Where this family is in the process. Nothing here is about payment." },
    { "name": "Lessons", "type": "DOUBLE", "role": "formula", "owner": "agent",
      "note": "From the teacher's term count on Settings, unless the override says otherwise." },
    { "name": "Term fee", "type": "CURRENCY", "role": "formula", "owner": "agent",
      "note": "Lessons times the rate for this lesson length." },
    { "name": "Lesson override", "type": "DOUBLE", "role": "input", "owner": "human",
      "note": "Only when this student's count differs from their teacher's default. Leave blank otherwise." },
    { "name": "Check", "type": "TEXT", "role": "check", "owner": "agent",
      "note": "The sheet checking itself. Resolve what it says rather than deleting the column." }
  ],
  "freeze_header": true,
  "status_fill_rules": true,
  "status_column": "Status",
  "status_roles": {
    "Time confirmed by family": "ok",
    "Time offered to family": "warn",
    "Waitlisted": "warn",
    "Not continuing this term": "muted"
  }
}
```

Worth noticing in that call:

**The status values are sentences.** "Time offered to family" is a state a
person understands without being told the system. A colleague opening this sheet
in week three knows exactly what it means.

**Ownership is per column, not one range.** Six columns are marked `human` and
three `agent`. That is the contract every later write is checked against, and it
is what turns a stray write into somebody's typing into a refusal rather than a
surprise.

**`status_roles` maps options to fill roles explicitly.** Any option left out is
painted with the `muted` role, so name every option whose color you care about.

**The Table starts at row 1** so the header freezes cleanly. The summary count
goes on the About tab rather than above the data.

## 4. Help text is its own call

A Table column carries a `note` on its header cell. Help text, the tooltip that
appears when somebody clicks into the cell, belongs to the validation rule, so it
is set separately over the data rows:

```json
sheets_validation {
  "sheet": "Roster",
  "range": "F2:F20",
  "type": "list",
  "values": [
    "Interest noted, details pending",
    "Details in, time not yet offered",
    "Time offered to family",
    "Time confirmed by family",
    "Waitlisted",
    "Not continuing this term"
  ],
  "help": "Where this family is in the process, not whether they have paid."
}
```

The range excludes the header row. This rewrites a rule the plugin itself
created, which is fine. On a rule a person made by hand it would need `force`,
and it would destroy their chip colors.

## 5. Fill the formula columns

`fill` writes one formula into the first cell of a bounded single-column range
and autofills it down, adjusting references as it goes. It takes a `sheet` and a
`range`, not a Table name and a column name.

```json
sheets_write {
  "sheet": "Roster",
  "mode": "fill",
  "range": "G2:G20",
  "formula": "=IF($D2=\"\", \"\", XLOOKUP($D2, Teacher_Key, Teacher_Lessons, \"\"))"
}
```

Returns a `check`. Read it even when one formula went in. It is the habit that
catches a lookup pair named backwards.

```json
sheets_write {
  "sheet": "Roster",
  "mode": "fill",
  "range": "H2:H20",
  "formula": "=LET(\n  lessons, IF($I2<>\"\", $I2, $G2),\n  rate, XLOOKUP($E2 & \"\", Rate_Length, Rate_PerLesson, 0),\n  inactive, $F2=\"Not continuing this term\",\n  IF(OR(inactive, lessons=\"\", rate=0), \"\", rate * lessons)\n)"
}
```

Which lands in the cell as:

```
=LET(
  lessons, IF($I2<>"", $I2, $G2),
  rate, XLOOKUP($E2 & "", Rate_Length, Rate_PerLesson, 0),
  inactive, $F2="Not continuing this term",
  IF(OR(inactive, lessons="", rate=0), "", rate * lessons)
)
```

Four clauses, so it gets real newlines, and every number in it comes from a
named range.

**The `& ""` on the lookup key is load bearing.** A dropdown whose options read
`30`, `45`, `60` stores them as numbers, while the labels in `Rate_Length` are
text. Comparing the two matches nothing, `XLOOKUP` returns its fallback, and the
fee column comes back empty with no error value anywhere. A clean lint over a
blank column is exactly the failure this guide warns about, and coercing the key
is the fix.

Then the Check column:

```json
sheets_write {
  "sheet": "Roster",
  "mode": "fill",
  "range": "J2:J20",
  "formula": "=LET(\n  has_student, $A2<>\"\",\n  no_email, AND(has_student, $B2=\"\"),\n  no_teacher, AND(has_student, $D2=\"\"),\n  no_length, AND(has_student, $E2=\"\"),\n  IF(NOT(has_student), \"\",\n    TEXTJOIN(\"; \", TRUE,\n      IF(no_email, \"No guardian email\", \"\"),\n      IF(no_teacher, \"No teacher yet\", \"\"),\n      IF(no_length, \"No lesson length\", \"\")))\n)"
}
```

Every message is a sentence a colleague can act on. Not `ERR_MISSING_FIELD_B`.

## 6. Paint the flags, do not paint the cells

`ranges` is an array, the test is an `operator`, and what the rule paints goes in
`format`:

```json
sheets_conditional_format {
  "sheet": "Roster",
  "action": "add",
  "ranges": ["J2:J20"],
  "kind": "boolean",
  "operator": "not_blank",
  "format": { "fill": "flag" }
}
```

The Status column already has its fills from `status_fill_rules` in step 3, so
it needs nothing here.

Rules, not painted cells. A painted cell is not data: it does not sort, does not
filter, nothing can count it, and it does not survive a row insert. A rule
applies itself to every row anyone adds from now on, including rows added by
hand six weeks from now.

## 7. Add the data

`append` takes `records`, rows keyed by header name in any column order. The
header row decides where each value lands.

```json
sheets_write {
  "sheet": "Roster",
  "mode": "append",
  "records": [
    { "Student": "Wren A.", "Guardian email": "wren.family@example.com",
      "Instrument": "Cello", "Teacher": "N. Okafor", "Length": "30",
      "Status": "Time confirmed by family" },
    { "Student": "Idris B.", "Guardian email": "idris.home@example.com",
      "Instrument": "Piano", "Teacher": "T. Bright", "Length": "45",
      "Status": "Time offered to family" },
    { "Student": "Juno C.", "Guardian email": "juno.c@example.com",
      "Instrument": "Violin", "Teacher": "H. Kerr", "Length": "30",
      "Status": "Details in, time not yet offered" }
  ]
}
```

One call, one write, one gate. Returns
`check: { status: "success", total_formulas: 12, total_errors: 0 }`.

**Now do the arithmetic by hand.** Wren is 30 minutes with N. Okafor, so 14
lessons at $80 is $1,120. Read the cell back and confirm the sheet says $1,120.
A green check means the formulas evaluated. It does not mean the lookup pointed
at the right column, and this is the only step that catches that.

## 8. The About tab

```json
sheets_write {
  "sheet": "About",
  "mode": "range",
  "range": "A1:A7",
  "values": [
    ["Rivermill private lessons, spring term"],
    [""],
    ["One row per student. Add a row at the bottom as families sign up."],
    ["Columns A to F and the lesson override in I are yours to fill in. Lessons, term fee, and Check calculate themselves, so anything typed over them will be lost."],
    ["Rates and per-teacher lesson counts live on the Settings tab. Change them there and every fee updates."],
    ["The Check column flags rows that are missing something. Fix what it says rather than deleting the column."],
    ["Confirmed so far:"]
  ]
}
```

```json
sheets_write {
  "sheet": "About",
  "mode": "range",
  "range": "B7",
  "values": [["=COUNTIF(Roster[Status], \"Time confirmed by family\")"]]
}
```

A structured reference, so the count keeps working as the Table grows. Seven
lines written to a colleague. This is the highest-value thing in the whole build
and it takes two calls.

## 9. Verify, look, stop

```json
sheets_check { "sheets": ["Roster", "Settings", "About"] }
```

```json
{
  "status": "success",
  "total_formulas": 15,
  "total_errors": 0,
  "error_summary": {},
  "findings": []
}
```

```json
sheets_render { "sheet": "Roster" }
```

Returns a file path. Read it and look. On this build the first render showed the
Guardian email column too narrow, so:

```json
sheets_style {
  "sheet": "Roster",
  "column_widths": [{ "columns": "B:B", "pixels": 220 }]
}
```

Re-render only `Roster`, confirm it reads, and stop. One fix pass, not an
open-ended polish loop.

One thing in this image is misleading, and it is worth expecting. **Teacher,
Length, and Status render as plain black text, with no pills and no dropdown
arrows.** That is how every API-created dropdown renders, and it looks exactly
like a cell carrying no rule at all. The rules are there, `sheets_check`
confirms them, and the fills from the conditional rules do paint.

Do not re-create a dropdown because the picture looked bare. Here it would
rewrite a working rule for nothing. On a sheet where a colleague had colored the
options by hand, it would destroy those colors permanently.

## What the finished sheet does that a script's output would not

- A colleague adds a row at the bottom and the fee calculates itself, the flag
  rule applies itself, and the count on About goes up. Nothing needs rerunning.
- The rate changes in March. One cell on `Settings`, every fee updates, and the
  source beside it says who confirmed the old one.
- Somebody asks why one student has fourteen lessons instead of sixteen. The
  answer is a cell on the Settings tab, not a conversation.
- A row is missing an email and the sheet says so, in words, in a column
  somebody can filter on.
