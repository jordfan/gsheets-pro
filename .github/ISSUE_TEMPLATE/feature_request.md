---
name: Feature request
about: Something gsheets-pro cannot do yet, or could do better
title: ""
labels: enhancement
assignees: ""
---

## What you are trying to do

Describe the spreadsheet outcome you want, not just the API call you think
is missing. "I want a totals row that recalculates" is more useful than
"add footer support," because it lets the response explain the tradeoff
(`sheets_table`'s footer field destroys the last data row, so a totals row
lives above the Table instead) if a workaround already exists.

## What you tried

Which tool or tools you reached for, and what happened, even if this is not
a bug (the tool refused with a reason, or did something technically correct
but not what you wanted).

## Check `docs/LIMITATIONS.md` first

Some gaps are permanent (no API for named functions, no chip colors, no
comment threads) because the Sheets API does not expose them at all, not
because nobody got to it. If your request runs into one of these, say so
and describe the workaround you are hoping for instead, since a
feature request against an API limit usually turns into a docs or
`sheets_batch` question rather than new tool code.

## Proposed shape, if you have one

Which tool this belongs on, what the new argument or mode would look like,
and whether it is additive (safe to ship without a version bump to the tool
surface) or changes existing behavior.

## Anything else

Prior art in another Sheets tool, a link to the relevant part of the API
discovery doc, or a sketch of the spreadsheet you are trying to build.
