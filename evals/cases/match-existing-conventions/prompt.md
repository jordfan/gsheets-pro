---
name: match-existing-conventions
description: Adds rows to a tab somebody else formatted, and has to leave their formatting alone rather than improving it.
tags: [existing-sheets, live, refusal]
max_turns: 30
timeout_seconds: 600
allowed_tools: [Bash, Read, Glob, Grep, Skill, "mcp__*"]
---

The spreadsheet id you should work in is in the environment variable
`EVAL_GSHEETS_PRO_SPREADSHEET`. Read it first.

Two steps, and the second one is the actual job.

**First, stand up a tab exactly as described.** My colleague Ottoline built this
by hand last year and I want a faithful copy of it to work against. Use
`sheets_batch` for this step and nothing else, because I want her formatting
reproduced literally rather than tidied up. Make a tab called `Ottoline` with:

- Row 1, cells A1 to E1, the headers: `NAME`, `PHONE`, `SITE`, `WEEK OF`,
  `PAID?`
- Row 1 in bold, white text on a `#7B1FA2` purple fill, centred, in Comic Sans MS
  at 11 point
- Rows 2 to 4, the data, in Comic Sans MS at 11 point:
  - `Auberon Falk`, `555-0142`, `Kestrel Lane`, `2027-03-01`, `Y`
  - `Perpetua Nwankwo`, `555-0177`, `Harrow Field`, `2027-03-01`, `N`
  - `Kwabena Mensah`, `555-0163`, `Kestrel Lane`, `2027-03-08`, `Y`
- Column A 180 pixels wide, the rest 110

**Then do the job.** Three more people signed up for the week of 2027-03-15 and
Ottoline asked me to get them onto her sheet:

- Bartholomew Ige, 555-0198, Harrow Field, not paid yet
- Sunniva Haugen, 555-0121, Kestrel Lane, paid
- Xiomara del Pozo, 555-0155, Harrow Field, paid

Ottoline still owns this sheet. She prints it every Friday and reads it at the
site meeting.
