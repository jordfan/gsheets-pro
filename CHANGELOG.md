# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project intends to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once it ships a first release.

## [Unreleased]

Pre-release. Nothing has been published to npm, the MCP registry, or a
plugin marketplace yet; this section describes what exists on `main` today,
ahead of the v1.0 publication gate in `docs/PLAN.md` § Publication gate.

### Added

- Core server library and both transports (stdio and stateless HTTP), with
  `sheets_open` and `sheets_read` live tested against a real spreadsheet.
- `sheets_write` (range, append, upsert, fill, log, batch `rows` form), with
  the formula guard, registry refusals, and the recalc-shaped error gate on
  every write.
- `sheets_style` (preset roles and explicit props, theme apply, banding,
  sheet properties) and the preset compiler (`neutral`, `park`,
  `finance-classic`).
- `sheets_table`, `sheets_settings`, `sheets_validation`, and
  `sheets_conditional_format`, covering native Tables, the Settings and
  Assumptions block with auto named ranges, dropdown and other validation
  rules, and fingerprint-addressed conditional formatting.
- `sheets_structure`, `sheets_find`, and `sheets_batch`, covering tab and
  dimension operations, Drive-side search and sharing, and the raw
  `batchUpdate` escape hatch for the request types the other tools do not
  wrap.
- `sheets_check`, the lint (seven v1 rules: formula errors, merges in data,
  missing frozen header, writes outside designated columns, key column
  blank or duplicate, check-column flags, colleague-unsafe text), and
  `sheets_render`, which paints a tab or range to a PNG and never returns
  image bytes over MCP.
- The house-style skill, its references, two worked example transcripts, the
  card generator with a CI token budget, the `session-start` and
  `first-call` hooks that inject the card, the `sheet-reviewer` agent, and
  the `setup` and `review` skills.
- The repo-level registry (`.claude/gsheets-pro.json`) and developer-metadata
  contract, protecting known shared spreadsheets and agent-created sheets
  from unsafe rewrites.
- A Dockerfile, `docs/hosting.md`, and `scripts/vendor.mjs` for teams whose
  scheduled Claude Code runs need the guide copied into their own repo,
  since a plugin declared in a repository's settings does not install in a
  cloud run (`docs/cloud.md`).
- 801 offline tests (vitest), covering every tool, every lint rule, both
  transports, and the field-mask, registry, contract, and theme-compilation
  logic. A separate live suite, paced through a shared quota bucket, runs
  against a disposable spreadsheet and skips itself without one.

### Known limitations

See `docs/LIMITATIONS.md` for the full list. The load-bearing ones: no
dropdown chip colors through the API in either direction, and rewriting a
validation rule the plugin did not create destroys them; `sheets_build` (the
declarative one-call workbook builder) is deferred to v1.1; no elicitation,
so every confirmation is an argument or a permission decision, never an
interactive prompt from the server; Path A setup takes 15 to 25 minutes the
first time, and an unpublished OAuth consent screen expires its refresh
token after seven days.

[Unreleased]: https://github.com/jordfan/gsheets-pro/commits/main
