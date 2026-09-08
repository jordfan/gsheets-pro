# Working in a spreadsheet somebody else owns

The failure mode here is quiet. A build that goes wrong is obvious. A row
inserted in the wrong place, a column reformatted, a sort applied to a sheet
whose row order somebody's formula depends on: those are discovered days later
by a colleague who now trusts the spreadsheet less.

So this case gets its own rules, and they override everything else.

## Find out what you have first

`sheets_open` reports which of three situations you are in, and it says which
rather than guessing.

**A registry entry.** The repository has `.claude/gsheets-pro.json` and it names
this spreadsheet. This is the strongest signal, because it needs nothing written
into the sheet itself, so it works on the first call from a fresh clone. It
tells you the owner, which columns are writable, and whether row order is load
bearing.

**Developer metadata.** This plugin built or adopted the spreadsheet and
recorded a column contract in it: a logical name, a role, and an owner per
column. Metadata rides the column, so a renamed header surfaces as drift rather
than silently mismatching. There is no row metadata; the key column is
canonical.

Metadata is durable. It survives File > Make a copy, so a duplicated
spreadsheet arrives with its contract intact and its columns still protected.
That is worth knowing in both directions: a copy made to experiment on is still
governed by the original's contract, which is usually what you want, and
occasionally is not.

**No contract.** Neither of the above. `sheets_open` says "no contract" rather
than inferring one, because a confident wrong guess about who owns a column is
worse than an honest absence.

## When there is no contract

Assume everything belongs to somebody else.

Read the sheet before writing anything. Note the fonts, the header treatment,
the date format, the number formats, the column order, where totals live,
whether there is a status column and what its values are. Then match all of it,
including choices you would have made differently. Consistency with what is
already there is worth more to the people who read this sheet than any rule in
the style guide.

Then, for the common case of adding rows:

- Append at the last data row inside the region you were given.
- Change nothing else. Not the widths, not the formats, not the header.
- Do not sort. Do not insert or delete rows or columns. Do not restyle.
- Do not convert their range to a Table, however much it wants to be one.

A Table conversion, a theme application, or new banding on a spreadsheet a human
owns needs `force` and a stated reason, and the guard hook will stop the call
first. That is the design working, not an obstacle to route around.

## The registry file

`.claude/gsheets-pro.json` in a repository, committed alongside the code. It
protects known spreadsheets with no metadata and no setup:

```json
{
  "spreadsheets": {
    "1SyNtH3t1c_aBcDeF_ExampleSpreadsheetId_0001": {
      "name": "Vendor Onboarding Tracker",
      "owner": "shared",
      "writable_columns": ["A:F", "I"],
      "colleague_safe_text": true,
      "allowlist": ["batch", "sync"]
    },
    "1SyNtH3t1c_aBcDeF_ExampleSpreadsheetId_0002": {
      "name": "Lesson Schedule Draft",
      "owner": "human",
      "positional_rows": true
    }
  }
}
```

| Field | Effect |
|---|---|
| `owner` | `human`, `shared`, or `agent`. `human` and `shared` both trigger the restyling guard |
| `writable_columns` | A1 column ranges. A write outside them is refused without `force`, and lint rule L14 reports one that got through |
| `positional_rows` | Row order is load bearing. Sorting, inserting, deleting, and deduplicating rows are refused outright, not asked about |
| `colleague_safe_text` | Lint rule L23 runs on this spreadsheet's text |
| `allowlist` | Words L23 should not flag on this sheet |

The registry is also what the SessionStart hook reads. In a repository that has
one, the rules and the list of protected spreadsheets are injected before the
first prompt, so a session knows what it is not allowed to break before it tries.

## Adopting a spreadsheet

`sheets_table adopt` takes an existing well-formed range and records a contract
over it: column metadata, header notes, the key column. It writes metadata and
notes, and nothing else. It does not convert the range to a native Table, does
not restyle it, and does not touch a single value.

Adopt when a spreadsheet is going to be maintained by both people and this
plugin over time. It turns "no contract" into a real one, which is what makes
every later write safe.

Ask before adopting a spreadsheet you do not own. The notes it writes are
visible to everyone.

## Two things the API cannot round-trip

**Dropdown chip colors.** Colors set on dropdown values through the Sheets
interface cannot be read back through the API, and no validation rule carries a
color field. So rewriting a rule that a person created discards their colors
permanently. The plugin reports such a rule as `ui_owned` and refuses to rewrite
it without `force`. When a dropdown needs a new option, say so and let a person
add it, rather than recreating the rule.

**Anything only the interface can make.** Named functions, Apps Script,
threaded comments, and a few chart types. `references/limitations.md` has the
full list. If a sheet uses one, work around it rather than through it.
