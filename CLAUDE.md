# gsheets-pro

A Claude Code plugin (MCP server + skills + hooks) that makes Google Sheets a
brilliant, organized human would make: readable formulas, on-brand formatting,
native Tables, and sheets that agents and colleagues can maintain side by side.
Open source, MIT, `github.com/jordfan/gsheets-pro`. Not affiliated with the
GSheetsPro coaching product.

The full plan with the research behind every decision is `docs/PLAN.md`. Read
it once. This file is the short version plus the working conventions.

## Why this exists

Every serious Sheets MCP (the most-starred community server, Anthropic's
first-party connector, Google's own hosted Sheets MCP) ships zero formatting.
Nobody lints, nobody renders, nobody treats craft as a goal. This plugin does
three things nobody else does: formatting and native Tables as first-class
tools, a verify loop (lint + render) so Claude can check its own work, and
protections so an agent can share a sheet with humans without wrecking it.

## Hard constraints (verified 2026-09-07; do not design against them)

- Must work in Claude Code **cloud sessions**: stdio servers cannot run there,
  HTTP servers can. So the server is HTTP-first (stateless streamable HTTP,
  `enableJsonResponse`, a **new transport and McpServer per request** on SDK
  1.x, shared Google client and caches at module scope) and also runs as stdio.
- Build on `@modelcontextprotocol/sdk` **1.x** (Claude Code speaks the legacy
  protocol to plugin servers). No elicitation. Node 22+.
- Never return an MCP image content block (Claude Code mishandles them). A
  render returns a file path locally or a short-lived signed URL when hosted.
- Tool responses cap at 25k tokens by default; big reads declare
  `_meta["anthropic/maxResultSizeChars"]` and paginate.
- Tool names are `sheets_<verb>`; three prefixes exist in the wild
  (`mcp__plugin_gsheets_pro_local_sheets__`, `mcp__gsheets-pro__`,
  `mcp__claude_ai_Google_Workspace_Advanced__`). Hooks and skill text match on
  the **suffix** only.
- Sheets API facts live in `docs/PLAN.md` § Hard constraints (69 batchUpdate
  request types, Tables, theme slots, `ErrorValue.type` enum, no color on
  validation rules, quotas 60 reads + 60 writes per minute per user, one
  batchUpdate counts once). The discovery doc is the authority:
  `https://sheets.googleapis.com/$discovery/rest?version=v4`.

## Shape

```
plugins/gsheets-pro/        skills, hooks, presets, agent. No server. (cloud, hosted, connector users)
plugins/gsheets-pro-local/  adds the bundled stdio server for laptop users
src/cli.ts                  stdio | serve --http | auth | doctor | card
src/server.ts               registers the 14 tools; per-request instances for HTTP
src/tools/<tool>.ts         one file per tool
src/lib/                    a1, colors, numfmt, fieldmask, batch, errors, sheetcache,
                            metadata, registry, contract, theme, errorgate, rangeresolve,
                            safetext, spreadsheetid, render, auth
src/lib/lint/<rule>.ts      one pure function per rule
test/                       vitest, offline    test/live/  gated on GSHEETS_PRO_LIVE_SPREADSHEET
evals/cases/                claude plugin eval
docs/                       PLAN.md (gitignored), spikes.md, cloud.md, hosting.md, LIMITATIONS.md
scripts/                    vendor.mjs, card.mjs, release.mjs
LICENSE, NOTICE, SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md, CHANGELOG.md   repo root, publication gate
```

The 14 tools and what each wraps are tabulated in `docs/PLAN.md` § Tool
surface. `sheets_build` is v1.1.

## Conventions that make the output look human (the product, not decoration)

- Sheet **names** and **A1 ranges** everywhere; the server resolves ids and
  GridRanges. Colors are hex, named, or theme slots (`theme:ACCENT1`); prefer
  `ColorStyle.themeColor` so Format > Theme stays the human's knob.
- Every response: prose in `content[0].text` plus `structuredContent`. Errors
  are `isError: true` with `{ code, message, hint }` where the hint teaches the
  fix (404: "the long id in the URL, not the whole URL").
- One `batchUpdate` per call, field masks built from the arguments actually
  passed, 429 backoff.
- Every write ends with a masked `spreadsheets.get` over what it touched and
  returns a recalc-shaped `check` keyed on `ErrorValue.type`.
- Formulas pass through byte for byte. Never rewrite a colleague's formula. A
  write refuses to replace a formula cell without `force`.
- Never rewrite a validation rule the plugin did not create (the API cannot
  round-trip UI chip colors). Report it as `ui_owned` instead.
- A repo-level registry (`.claude/gsheets-pro.json`) protects known shared
  sheets with no metadata needed: owner, writable columns, positional rows.
- Presets compile to a full spreadsheet theme plus role tokens; `neutral` is
  the default, `park` and `finance-classic` are peers. Archetype `tracker`
  (default) vs `model` decides whether font color encodes data role.
- Text written to a shared sheet reads as if a colleague wrote it: no message
  ids, no "agent", no "run report", no "TODO:".

## Working here

- `npm test` must stay green offline. Live tests need
  `GSHEETS_PRO_LIVE_SPREADSHEET` and a token; never commit either.
- **Secrets never enter a transcript.** Credentials come from env or files
  named in `.gitignore`; scripts may use them, nobody prints them.
- Fixtures and docs use invented names and synthetic spreadsheet ids. No real
  people, schools, spreadsheet ids, hostnames, or GCP project names in this
  repo; deployment specifics belong to whoever hosts it.
- Docs must match reality: when a path, tool, or fact in any doc here is wrong,
  fix the doc in the same session.
- Prose style for anything user-facing (README, skill, tool descriptions,
  hints): plain, warm, specific. No em dashes. No slang.
- Lifted by hand from an earlier internal server, with its offline tests: the
  A1 parser, color and number-format helpers, the sheet-name cache, and the
  error-hint shape. Everything else is new; do not fork the old code.
- Commit messages say what changed and why, one to three sentences. Trailer:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
