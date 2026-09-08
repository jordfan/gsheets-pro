---
name: Bug report
about: Something in gsheets-pro did not behave the way the docs say it should
title: ""
labels: bug
assignees: ""
---

## What happened

A clear description of what went wrong. If a tool call returned an error,
paste the full `{ code, message, hint }` it gave back.

## What you expected

What should have happened instead, and where you got that expectation from
(a line in the README, a skill reference, a tool description).

## `gsheets-pro doctor` output

Run `npx gsheets-pro doctor` (or `gsheets-pro doctor` inside your hosted
container) and paste its output. Most setup and credential problems show up
here in one line.

```
paste doctor output
```

## Environment

- **How you run it:** laptop with `gsheets-pro-local` (stdio) / self-hosted
  `gsheets-pro serve --http` / Claude Code cloud session via a hosted server
- **Auth path:** Path A (own OAuth client) / Path B (gcloud ADC) / hosted
  bearer with a pre-provisioned token
- **`gsheets-pro --version` or `package.json` version:**
- **Node version:**
- **OS:**

## Steps to reproduce

1.
2.
3.

If you can reproduce it against a disposable spreadsheet and are willing to
share the tool call and its arguments (with any real names or ids replaced
with invented ones), that is the single most useful thing you can attach.

## Anything else

Logs, a render PNG, whatever else seems relevant. Please do not paste a real
spreadsheet id, a real person's name, a token, or an OAuth client secret
into this issue. If the bug is a security issue rather than an incorrect
behavior, see `SECURITY.md` instead of filing it here.
