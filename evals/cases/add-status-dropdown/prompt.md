---
name: add-status-dropdown
description: Adds a status column to an existing block and has to word the options as sentences a colleague understands rather than as internal state codes.
tags: [edit, live]
max_turns: 30
timeout_seconds: 600
allowed_tools: [Bash, Read, Glob, Grep, Skill, "mcp__*"]
---

The spreadsheet id you should work in is in the environment variable
`EVAL_GSHEETS_PRO_SPREADSHEET`. Read it first.

Make a new tab called `Repairs` in that spreadsheet and put this in it, one row
per item, with a header row:

| Item | Owner | Dropped off | Notes |
|---|---|---|---|
| Bandsaw, 14 inch | Harriet Voss | 2027-02-03 | Blade guide is loose |
| Espresso grinder | Kwabena Mensah | 2027-02-05 | Burrs need replacing, part ordered |
| Sewing machine, Elna | Perpetua Nwankwo | 2027-02-09 | Tension is off, not urgent |
| Cargo bike | Silas Adeyemi | 2027-02-11 | Rear hub, waiting on the owner to confirm they want it done |
| Table lamp | Iolanthe Brecht | 2027-02-14 | Rewired, ready to collect |

Then add a status column so the repair volunteers can say where each item is
without typing something different every time. Restrict it to a fixed set of
choices and set the five rows above to whichever choice fits what the notes say.

The people using this are volunteers who come in on Saturdays, not staff. Some of
them will have seen the sheet for the first time that morning.
