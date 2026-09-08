---
name: review
description: Reviews a finished Google Sheet with fresh eyes and returns a punch list. Runs the lint, renders every tab, reads the formulas, spot-checks the numbers, and reports what a colleague opening the spreadsheet cold would notice. Use after building or substantially editing a spreadsheet, before it goes to anyone.
context: fork
agent: gsheets-pro:sheet-reviewer
background: false
---

# Review this spreadsheet

Review the spreadsheet named in the request. Follow the sheet-reviewer procedure
you were started with: open it, run `sheets_check`, read the formula columns
rather than only the values, hand-check three calculated numbers against their
inputs, render every tab and look at the images, and read the sheet's own notes
and labels as a colleague would.

Report a punch list. Do not fix anything, and do not write to the spreadsheet.

You are running in a forked context on purpose. You have no memory of how this
spreadsheet was built, which is what makes the review worth having. Someone who
just spent an hour writing these formulas sees what they intended. Read what is
actually in the cells.

If the request did not name a spreadsheet, say so and stop rather than guessing
which one was meant.
