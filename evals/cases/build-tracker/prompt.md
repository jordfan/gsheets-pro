---
name: build-tracker
description: Builds a shared tracker from nothing and has to reach for a Table, a Settings block, a filled formula column, the lint and a render without being told to.
tags: [build, live, artifact]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Bash, Read, Glob, Grep, Skill, "mcp__*"]
---

The spreadsheet id you should work in is in the environment variable
`EVAL_GSHEETS_PRO_SPREADSHEET`. Read it first.

Build me a tracker for next season's volunteer shifts at the Ardenwood Tool
Library. Work in a new tab called `Shifts` and put the numbers it depends on in
a new tab called `Shift settings`, so nothing collides with what is already in
that spreadsheet.

Here is what I need to see for each volunteer: who they are, how to reach them,
which station they cover, which shift they took, how far along we are with them,
how many hours that works out to, and what we owe them in stipend.

The stipend is eight dollars an hour and the season runs fourteen weeks. A
morning shift is three hours and an evening shift is four. Some people volunteer
a different number of weeks than the season length, and I need to be able to say
so per person without breaking the arithmetic for everyone else.

The stations are Woodshop, Metal, Textiles, and Front desk. Start it off with
these five:

- Marguerite Oyelaran, m.oyelaran@example.org, Woodshop, morning, all confirmed
- Devansh Rao, devansh.rao@example.org, Metal, evening, confirmed
- Bea Lindqvist, bea.l@example.org, Textiles, morning, we have offered her a
  slot and are waiting to hear back
- Tomasz Ferreira, t.ferreira@example.org, Front desk, evening, confirmed, but
  he is only here for nine of the fourteen weeks
- Ngozi Abara, ngozi.abara@example.org, Woodshop, evening, she has said she is
  interested but we have not sorted out details

Other people at the library will maintain this after you, so it needs to survive
them adding rows at the bottom without anything breaking.

When the sheet is finished, render the `Shifts` tab and copy the rendered PNG to
`./shifts.png` in your working directory so I can look at it. Then tell me what
you built and what the lint said.
