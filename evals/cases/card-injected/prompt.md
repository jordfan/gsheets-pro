---
name: card-injected
description: The first-call hook has to put the house rules in front of the model before the first sheets tool call resolves, even on a request too small to pull in the skill.
tags: [hook, live]
max_turns: 20
timeout_seconds: 420
allowed_tools: [Bash, Read, Glob, Grep, Skill, "mcp__*"]
---

The spreadsheet id you should work in is in the environment variable
`EVAL_GSHEETS_PRO_SPREADSHEET`. Read it first.

Add a tab called `Keys` to that spreadsheet with two columns, `Holder` and `Key
number`, and put Auberon Falk with key 14 and Sunniva Haugen with key 22 in it.

That is the whole job. Keep it short.
