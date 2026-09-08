---
name: audit-sheet
description: A tab with four planted defects goes out to the board tomorrow. The run should lint it, look at it, hand it to the reviewer, and come back with a punch list rather than a reassurance.
tags: [verify, live]
max_turns: 35
timeout_seconds: 900
allowed_tools: [Bash, Read, Glob, Grep, Skill, Task, "mcp__*"]
---

The spreadsheet id you should work in is in the environment variable
`EVAL_GSHEETS_PRO_SPREADSHEET`. Read it first.

**Set this tab up first, exactly as described.** Use `sheets_batch` and nothing
else for this step, because I want it reproduced as it is rather than corrected
on the way in. Make a tab called `Board` with:

- A1 to D1 merged into one cell reading `Quarterly grant spend`
- Row 2, the headers in A2 to D2: `Programme`, `Budget`, `Spent`, `Remaining`
- Rows 3 to 6:
  - `Kestrel Lane outreach`, `12000`, `9400`, formula `=B3-C3`
  - `Harrow Field repairs`, `8000`, `8250`, formula `=B4-C4`
  - `Old Mill tools`, `15000`, `11100`, formula `=B5-C5`
  - `Cobbett Yard`, `6000`, `5900`, formula `=B6-C6`
- B7 and C7 merged into one cell, with the formula `=SUM(B3:B6)` in it
- D8 with the formula `=D3/D9`
- A10 with the text `TODO: chase Perpetua re msg 18f2a4c, agent run 2027-03-02`
- No frozen rows

**Then the actual job.** This goes to the board tomorrow morning. Go over it
properly and tell me everything you would want fixed before I send it. Do not fix
anything yourself, and do not write to the sheet: I want the list so I can decide
what matters.
