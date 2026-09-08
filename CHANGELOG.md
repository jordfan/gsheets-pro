# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project intends to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once it ships a first release.

## [Unreleased]

Nothing yet.

## [0.1.0] - 2026-09-07

Pre-release. Nothing has been published to npm, the MCP registry, or a
plugin marketplace yet; this section describes what exists on `main` today,
ahead of the v1.0 publication gate in `docs/PLAN.md` § Publication gate.

### Added

- Core server library, stdio and stateless HTTP transports.
- All 13 v1.0 tools: `sheets_open`, `sheets_read`, `sheets_write`,
  `sheets_table`, `sheets_settings`, `sheets_style`, `sheets_validation`,
  `sheets_conditional_format`, `sheets_structure`, `sheets_find`,
  `sheets_batch`, `sheets_check`, `sheets_render`.
- `sheets_read`: several `ranges` in one call.
- `sheets_write`: a write ledger every writing tool records to, which
  `sheets_check`'s lint rule L14 (writes outside designated columns) reads
  instead of taking its own `writes` argument.
- `sheets_table`: writes the header cells it names when it creates a Table,
  rather than requiring them to exist first.
- `sheets_validation`: records the rules it sets, so it knows its own the
  next time it has to decide whether a rule is `ui_owned`.
- `sheets_find`: a `folders` action, and paging (`page_token`) on both
  `list` and `folders`.
- The preset compiler (`neutral`, `park`, `finance-classic`): a `muted_fill`
  role, distinct from the `muted` text color, and contrast validation
  across every fill a preset can emit, not only the header.
- The repo-level registry (`.claude/gsheets-pro.json`): owner, writable
  columns, `positional_rows`, `read_only`, and per-tab overrides under a
  `sheets` key.
- The developer-metadata contract, protecting agent-created sheets from
  unsafe rewrites.
- The house-style skill, its references, worked example transcripts, the
  card generator with a CI token budget, four hooks, the `sheet-reviewer`
  agent, and the `setup` and `review` skills.
- A Dockerfile, `docs/hosting.md`, and the `gsheets-pro vendor` CLI
  subcommand, for repositories whose scheduled Claude Code runs need the
  guide copied in, since a plugin declared in a repository's settings does
  not install in a cloud run (`docs/cloud.md`).
- The project site (`site/`) and its publish workflow.
- 951 offline tests (vitest), covering every tool, every lint rule, both
  transports, and the field-mask, registry, contract, and theme-compilation
  logic. A separate live suite (45 cases), paced through a shared quota
  bucket, runs against a disposable spreadsheet and skips itself without
  one.

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
[0.1.0]: https://github.com/jordfan/gsheets-pro/releases/tag/v0.1.0
