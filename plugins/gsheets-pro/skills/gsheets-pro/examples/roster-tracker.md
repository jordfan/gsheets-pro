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

---

## 1. Create the spreadsheet

```json
sheets_open {
  "create": {
    "title": "Rivermill Private Lessons: Spring Term",
    "preset": "neutral",
    "tabs": [
      { "name": "Roster",   "role": "outputs" },
      { "name": "Settings", "role": "inputs" },
      { "name": "About",    "role": "outputs" }
    ]
  }
}
```

Returns `spreadsheet_id: "1EXAMPLEr0st3rTrackerSyntheticId000001"`, the three
tabs, and `contract: { source: "metadata", columns: [] }`. Creating through
`sheets_open` applies the preset theme and colors the tabs by role in the same
call, so `Settings` is already visibly the inputs tab.

Every call below carries that `spreadsheet_id`. It is elided from here on.

## 2. Write the assumptions before anything that depends on them

```json
sheets_settings {
  "sheet": "Settings",
  "block": "Lesson rates",
  "rows": [
    { "label": "30 minutes", "value": 80,  "unit": "$ per lesson",
      "note": "Term rate, confirmed by the office 2027-01-12." },
    { "label": "45 minutes", "value": 120, "unit": "$ per lesson",
      "note": "Term rate, confirmed by the office 2027-01-12." },
    { "label": "60 minutes", "value": 160, "unit": "$ per lesson",
      "note": "Term rate, confirmed by the office 2027-01-12." }
  ],
  "names": { "key": "Rate_Length", "value": "Rate_PerLesson" }
}
```

Then a second block, in the same shape, for the teachers:

```json
sheets_settings {
  "sheet": "Settings",
  "block": "Teachers",
  "rows": [
    { "label": "N. Okafor", "value": 14, "unit": "lessons this term",
      "note": "Teaching Tuesdays and Thursdays. Two weeks off in March." },
    { "label": "T. Bright", "value": 16, "unit": "lessons this term",
      "note": "Full term." },
    { "label": "H. Kerr",   "value": 16, "unit": "lessons this term",
      "note": "Full term." }
  ],
  "names": { "key": "Teacher_Key", "value": "Teacher_Lessons" }
}
```

Two named ranges per block, so `Rate_Length` and `Rate_PerLesson` line up as a
lookup pair and `XLOOKUP` reads cleanly. Each row carries a note giving the
number a source, which is what makes it defensible in March when somebody asks
why one teacher has fourteen.

The tool applies a warning-only protection over both blocks. A colleague who
genuinely needs to change a rate still can, and gets a nudge on the way.

## 3. Build the Table

```json
sheets_table {
  "action": "create",
  "sheet": "Roster",
  "name": "Roster",
  "anchor": "A3",
  "title": "Private lessons, spring term",
  "freeze_header": true,
  "columns": [
    { "name": "Student", "type": "TEXT", "key": true,
      "note": "Preferred name, as the family writes it." },
    { "name": "Guardian email", "type": "TEXT",
      "note": "The address term reminders go to." },
    { "name": "Instrument", "type": "TEXT" },
    { "name": "Teacher", "type": "DROPDOWN", "source": "Teacher_Key",
      "help": "Pick from the teachers on the Settings tab." },
    { "name": "Length", "type": "DROPDOWN", "options": ["30", "45", "60"],
      "help": "Minutes. Most students take 30." },
    { "name": "Status", "type": "DROPDOWN",
      "options": [
        "Interest noted, details pending",
        "Details in, time not yet offered",
        "Time offered to family",
        "Time confirmed by family",
        "Waitlisted",
        "Not continuing this term"
      ],
      "help": "Where this family is in the process, not whether they have paid." },
    { "name": "Lessons", "type": "DOUBLE", "role": "formula",
      "note": "From the teacher's term count on Settings, unless the override says otherwise." },
    { "name": "Term fee", "type": "CURRENCY", "role": "formula",
      "note": "Lessons times the rate for this lesson length." },
    { "name": "Lesson override", "type": "DOUBLE", "role": "input",
      "note": "Only when this student's count differs from their teacher's default. Leave blank otherwise." },
    { "name": "Check", "type": "TEXT", "role": "formula",
      "note": "The sheet checking itself. Resolve what it says rather than deleting the column." }
  ],
  "human_columns": "A:F,I"
}
```

Worth noticing in that call:

**The status values are sentences.** "Time offered to family" is a state a
person understands without being told the system. A colleague opening this
sheet in week three knows exactly what it means.

**The status column does not say anything about payment.** The help text says so
out loud, because the second most likely misreading of a status column is that
it tracks money.

**`human_columns` is `A:F,I`.** Columns A through F are the ones a person fills
in, and I is the override. G, H, and J are computed. Writing that down now is
what lets a later `sheets_write` refuse to stamp over somebody's typing.

**Every dropdown has help text and every computed column has a note.** These are
the sheet's documentation, and they are cheap to write while building and
expensive to reconstruct later.

## 4. Fill the formula columns

One formula per column, written once, autofilled down:

```json
sheets_write {
  "mode": "fill",
  "table": "Roster",
  "column": "Lessons",
  "formula": "=IF($D4=\"\", \"\", XLOOKUP($D4, Teacher_Key, Teacher_Lessons, \"\"))"
}
```

Returns `check: { status: "success", total_formulas: 1, total_errors: 0 }`. One
formula, because the Table is still empty. Read it anyway. It is the habit that
catches the case where the lookup pair was named backwards.

```json
sheets_write {
  "mode": "fill",
  "table": "Roster",
  "column": "Term fee",
  "formula": "=LET(\n  lessons, IF($I4<>\"\", $I4, $G4),\n  rate, XLOOKUP($E4, Rate_Length, Rate_PerLesson, 0),\n  inactive, $F4=\"Not continuing this term\",\n  IF(OR(inactive, lessons=\"\", rate=0), \"\", rate * lessons)\n)"
}
```

Which lands in the cell as:

```
=LET(
  lessons, IF($I4<>"", $I4, $G4),
  rate, XLOOKUP($E4, Rate_Length, Rate_PerLesson, 0),
  inactive, $F4="Not continuing this term",
  IF(OR(inactive, lessons="", rate=0), "", rate * lessons)
)
```

Four clauses, so it gets real newlines. Every number in it comes from a named
range. The override is read once, at the top, so the rest of the formula does
not care whether it exists.

Then the Check column, which is the one that makes this sheet worth keeping:

```json
sheets_write {
  "mode": "fill",
  "table": "Roster",
  "column": "Check",
  "formula": "=LET(\n  has_student, $A4<>\"\",\n  no_email, AND(has_student, $B4=\"\"),\n  no_teacher, AND(has_student, $D4=\"\"),\n  no_length, AND(has_student, $E4=\"\"),\n  offered_no_teacher, AND($F4=\"Time offered to family\", $D4=\"\"),\n  IF(NOT(has_student), \"\",\n    TEXTJOIN(\"; \", TRUE,\n      IF(no_email, \"No guardian email\", \"\"),\n      IF(no_teacher, \"No teacher yet\", \"\"),\n      IF(no_length, \"No lesson length\", \"\"),\n      IF(offered_no_teacher, \"A time was offered but no teacher is assigned\", \"\")))\n)"
}
```

Every message is a sentence a colleague can act on. Not `ERR_MISSING_FIELD_B`.

## 5. Paint the flags, do not paint the cells

```json
sheets_conditional_format {
  "action": "add",
  "sheet": "Roster",
  "range": "Roster[Check]",
  "condition": { "type": "NOT_BLANK" },
  "fill": "flag"
}
```

```json
sheets_conditional_format {
  "action": "add",
  "sheet": "Roster",
  "range": "Roster[Status]",
  "condition": { "type": "TEXT_EQ", "value": "Time confirmed by family" },
  "fill": "ok"
}
```

Rules, not painted cells. A painted cell is not data: it does not sort, does not
filter, nothing can count it, and it does not survive a row insert. A rule
applies itself to every row anyone adds from now on, including rows added by
hand six weeks from now.

Both fills come from preset tokens, so changing the preset re-skins them.

## 6. Add the data

```json
sheets_write {
  "mode": "append",
  "table": "Roster",
  "rows": [
    { "Student": "Wren A.",   "Guardian email": "wren.family@example.com",
      "Instrument": "Cello",  "Teacher": "N. Okafor", "Length": "30",
      "Status": "Time confirmed by family" },
    { "Student": "Idris B.",  "Guardian email": "idris.home@example.com",
      "Instrument": "Piano",  "Teacher": "T. Bright", "Length": "45",
      "Status": "Time offered to family" },
    { "Student": "Juno C.",   "Guardian email": "juno.c@example.com",
      "Instrument": "Violin", "Teacher": "H. Kerr",   "Length": "30",
      "Status": "Details in, time not yet offered" }
  ]
}
```

One call, one `values.batchUpdate`, one gate. Returns
`check: { status: "success", total_formulas: 12, total_errors: 0 }`.

**Now do the arithmetic by hand.** Wren is 30 minutes with N. Okafor, so 14
lessons at $80 is $1,120. Read the cell back and confirm the sheet says $1,120.
A green check means the formulas evaluated. It does not mean the lookup pointed
at the right column, and this is the only step that catches that.

## 7. The summary and the About tab

```json
sheets_write {
  "mode": "range",
  "sheet": "Roster",
  "range": "A1:B1",
  "values": [["Confirmed", "=COUNTIF(Roster[Status], \"Time confirmed by family\")"]]
}
```

A structured reference, so the count keeps working as the Table grows.

```json
sheets_write {
  "mode": "range",
  "sheet": "About",
  "range": "A1:A6",
  "values": [
    ["Rivermill private lessons, spring term"],
    [""],
    ["One row per student. Add a row at the bottom as families sign up."],
    ["Columns A to F and the lesson override in I are yours to fill in. Lessons, term fee, and Check calculate themselves, so anything typed over them will be lost."],
    ["Rates and per-teacher lesson counts live on the Settings tab. Change them there and every fee updates."],
    ["The Check column flags rows that are missing something. Fix what it says rather than deleting the column."]
  ]
}
```

Six lines, written to a colleague. This is the highest-value thing in the whole
build and it takes one call.

## 8. Verify, look, stop

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

Returns a file path. Read it and look. On this build the first render showed
the Guardian email column too narrow, so:

```json
sheets_style {
  "sheet": "Roster",
  "range": "B:B",
  "column_width": 220
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
  rule applies itself, and the count in A2 goes up. Nothing needs rerunning.
- The rate changes in March. One cell on `Settings`, every fee updates, and the
  note next to it says who confirmed the old one.
- Somebody asks why one student has fourteen lessons instead of sixteen. The
  answer is a note on the Settings tab, not a conversation.
- A row is missing an email and the sheet says so, in words, in a column
  somebody can filter on.
