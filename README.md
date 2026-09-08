# gsheets-pro

**Pre-release. Under active development; not yet installable. Watch the repo for v0.1.**

A Claude Code plugin that makes Google Sheets the way a brilliant, organized
human would: readable formulas, on-brand formatting, native Tables, and sheets
that agents and colleagues can maintain side by side.

It is three things nobody else ships together:

- **Formatting and native Tables as first-class tools.** Themes, banding,
  typed Table columns, header notes, validation help text, protected ranges,
  named ranges, and a Settings block for inputs, all addressed by sheet name
  and A1 range.
- **A verify loop.** Every write returns an error gate read straight from the
  API. `sheets_check` lints the sheet (formula errors, merges in data, missing
  frozen headers, writes outside your columns). `sheets_render` produces a PNG
  so Claude can look at what it built.
- **Coexistence with humans.** A repo-level registry protects shared
  spreadsheets by id. Writes refuse to overwrite formulas or human-owned
  columns. Dropdowns a person built in the UI are never rewritten. Destructive
  changes need a confirmation, and in unattended runs they are refused with a
  reason.

One TypeScript server runs as a stdio process on a laptop or as a stateless
HTTP server for Claude Code cloud sessions and shared hosting. One skill carries
the house style, and a hook loads a short card of it on the first Sheets call
of every session.

## Status

| Piece | State |
|---|---|
| Core library, both transports, `sheets_open`, `sheets_read` | working, 279 offline tests |
| Skill, card, references, presets, hooks, reviewer agent | written, validated |
| `sheets_write`, `sheets_style`, presets compiler | in progress |
| `sheets_table`, `sheets_settings`, `sheets_validation`, `sheets_conditional_format` | in progress |
| `sheets_structure`, `sheets_find`, `sheets_batch` | in progress |
| `sheets_check`, `sheets_render`, the seven v1 lint rules | working, live tested |
| Docs, setup guide, evals, releases | later |

The API behaviors this design rests on were tested live; the verdicts are in
`docs/spikes.md`. Two of them prevent silent data loss that a naive
implementation would ship.

## License

MIT. Not affiliated with the GSheetsPro coaching-systems product.
