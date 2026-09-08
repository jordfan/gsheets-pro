# Phase 0 spikes

> **Last updated:** 2026-09-07

De-risking runs against the live Google Sheets API before Phase 1 starts. Each
spike answers one question the plan would be expensive to be wrong about. The
throwaway scripts that produced the evidence live in `spikes/` and are not part
of the shipped package.

Spike 2 (cloud sessions) is owned separately and is not covered here.

## Verdicts

| Spike | Question | Verdict |
|---|---|---|
| 1 | Does the export URL render a tab, and does the picture tell the truth? | **Go**, with a URL correction and a simpler auth story |
| 3 | Are native Tables usable the way the tool surface assumes? | **Go for `sheets_table`, no-go for two specific calls.** Two silent data-loss behaviors found |
| 4 | Does rewriting a dropdown preserve UI-set chip colors? | **Settled: it wipes them.** The plan's `ui_owned` rule is correct and now has evidence |
| 5 | Is PROJECT-visibility developer metadata a usable contract carrier? | **Go**, and it is more durable than the plan assumed |
| 6 | Does stateless HTTP hold under the aggregator's traffic? | **Go** |

All five spikes are resolved. Two plan assumptions were wrong in the plugin's
favor (metadata survives a copy; the render redirect needs no bearer). Two Tables
behaviors were wrong against it and change the tool surface. Spike 4 confirmed a
rule the plan already had, which means no design change but a hard constraint to
hold onto. Details below.

## Changes the plan needs

1. **`sheets_write append` on a Table must use `values.append`, not
   `appendCells(tableId)`.** The Tool surface table names `appendCells(tableId)`
   for `sheets_table` and `sheets_write`. That call silently discards the row
   values. See spike 3.
2. **`sheets_table` must never send `footerColorStyle`** unless the caller
   explicitly asks for a footer, because it destroys the last data row. See
   spike 3.
3. **The export URL must omit unused range parameters**, not send them empty.
   The template in the plan returns HTTP 400. See spike 1.
4. **`sheets_render` does not need to re-attach the bearer across the redirect.**
   A plain authorized fetch with default redirect following is enough, which
   removes hand-rolled redirect handling from the design. See spike 1.
5. **`sheets_open` should read contract metadata with `developerMetadata.search`,
   not with a `spreadsheets.get` mask.** One call returns all three location
   types; the masked `get` needs a different field path per type. See spike 5.
6. **Drop the claim that Make a copy loses the contract.** `drive.files.copy`
   preserved PROJECT-visibility metadata intact. See spike 5.
7. **The offline test suite needs a two-sequential-requests case** against one
   HTTP server. It is the only cheap assertion that catches transport reuse. See
   spike 6.
8. **`ui_owned` must be decided by provenance, not by inspecting the rule.** A
   human-styled dropdown is indistinguishable from a plugin-written one through
   the API, so the plugin has to know which rules it created rather than trying
   to detect styling. See spike 4.

## Spike 1, render: GO

**Scripts:** `spikes/spike1-render.mjs`, `spikes/spike1b-redirect-auth.mjs`,
pipeline in `spikes/lib/render.mjs`.

A tab was built carrying a merged title cell, a frozen header, a banded range, an
API-created dropdown, and two conditional-format rules, then rendered and looked
at.

**The picture tells the truth about formatting.** At 120 dpi the PNG paints the
merged title with its fill and white bold text, the header fill, the banding, and
both conditional-format rules, including a rule whose format is strikethrough
plus a font color rather than a fill. Conditional fills correctly override the
banding underneath them. Column widths are honored. This is good enough to be the
eval grader's input and good enough for a README screenshot.

**It never paints dropdowns as pills, but it does paint human-set chip colors as
colored text.** Three cases, all confirmed by looking at renders:

| Dropdown | How the export paints it |
|---|---|
| API-created `ONE_OF_LIST` with `showCustomUi: true` | plain black text, no pill, no arrow |
| Native Table column typed `DROPDOWN` | plain black text, no pill, no arrow |
| Human-styled in the UI with option colors and Chip display | text in the option's color, still no pill |

So a render can prove that a rule carries human-set colors, because the status
words come out green and red rather than black. It cannot prove that a dropdown
exists at all, because an uncolored rule is pixel-identical to plain text. Lint
stays authoritative for validation state, and `sheets_render` should say so in
its response rather than leaving the model to infer that a missing pill means a
missing rule.

That colored text is what made spike 4 answerable at all.

**`fzr=true` really does repeat the frozen header.** A 120-row tab exported to 4
pages, and page 2 carries the styled header row above the data. Worth keeping in
the default parameters.

**The export can brand a native Table's header row, and that is the second thing
the picture is not truthful about.** Building the golden demo produced a render
in which every header read `Student [1]`, `Guardian email [2]`, through
`Check [10]`, each with a column-type icon beside it. Read back from the live
spreadsheet, the header cells hold exactly `Student` through `Check` and the
Table's `columnProperties` hold the same ten names. The index and the icons are
painted by the export, not stored anywhere.

It is conditional and the condition is not isolated. The Table in this spike
renders clean, with a type icon on its dropdown column only, and it is a native
Table with typed columns created the same way. So something other than "is it a
Table" decides whether the export paints full header chrome. The untested
candidates, in the order worth trying, are the header notes the plugin writes,
the warning-only header protection, the frozen header, and a preset repaint of
the header row. Four renders varying one flag at a time would settle it.

Until it is settled: a render is for the agent's own eyes, and a picture of a
Table-based sheet that is going in front of people should be a browser
screenshot, which shows what a colleague actually sees.

### The URL template in the plan returns 400

The plan's URL sends `&gid=&r1=&c1=&r2=&c2=` with empty values. That is not the
same as omitting them: the endpoint answers **HTTP 400** with an HTML error page.
Omitting the five parameters when unused returns the PDF. `spikes/lib/render.mjs`
builds the query that way and the fix is one loop.

An empty `gid` is the whole-workbook case, which is a different render than "the
first tab", so `sheets_render` should always send an explicit `gid`.

### The redirect needs no bearer, which simplifies the tool

The plan assumes `Authorization` has to be re-attached after the 307 to
`googleusercontent.com`. It does not. Four cases:

| Request | Result |
|---|---|
| No `Authorization` at all | 401, HTML sign-in page |
| Authorized, automatic redirect following | 200, PDF |
| Authorized hop 0, bearer deliberately withheld on hop 1 | 200, PDF |
| Authorized hop 0, bearer re-attached on hop 1 | 200, PDF |

The bearer is required only on the first request to `docs.google.com`. The
redirect target is a pre-signed URL that carries its own credential in the query
string, so a plain `fetch(url, { headers: { Authorization } })` is sufficient and
`sheets_render` needs no manual redirect handling.

That pre-signed URL is a bearer-equivalent capability: anyone holding it can read
the sheet's rendered contents without authenticating. It must never be logged,
returned to a caller, or written into a response. The hosted mode's own
short-lived signed URL is a separate thing and is fine.

### Drive files.export is a weak fallback

`drive.files.export` works and paints the same formatting, but it exports the
**entire workbook**, one tab after another, and offers no control over gridlines,
orientation, fit, or range. The spike workbook came back as 5 pages, page 1 being
an empty default tab, with gridlines drawn on every page. Fine as a
last-resort fallback, not a substitute. `sheets_render` should warn when it falls
back, as the plan already says.

### The scope question is still open

**This token cannot answer whether the export URL works with only `spreadsheets`
+ `drive.file`.** The `tokeninfo` endpoint reports the available token carries:

```
https://www.googleapis.com/auth/drive
https://www.googleapis.com/auth/spreadsheets
```

That is full `drive`, so every result above was obtained with broader access than
Path A grants a stranger. Settling it needs a fresh consent against a Desktop
client scoped to exactly `spreadsheets` + `drive.file`. Until then, treat "render
works on Path A" as unverified and keep the Drive fallback wired up.

## Spike 3, Tables: GO for the feature, NO-GO for two calls

**Scripts:** `spikes/spike3-tables.mjs`, `spikes/spike3b-append-isolate.mjs`,
`spikes/spike3c-append-variants.mjs`.

The good news first, then the two behaviors that would have caused silent data
loss in production.

### What works

**`addTable` over a range that already has formatting and formulas is safe.** A
range holding `=D2*55` in every row and bold-italic headers took a Table
cleanly. The formulas survived byte for byte and still evaluate. `addTable`
applied its header color over the pre-existing header fill but left the header's
italic text format alone.

**`updateTable` replaces DROPDOWN options.** Going from two options to four was
accepted and read back correctly from the Table definition.

**`TableRowsProperties` colors are honored**, with one caveat below.

**`setBasicFilter` with `tableId` works** and binds to the Table's range,
tracking it as the Table grows.

### `footerColorStyle` destroys the last data row

Declaring `footerColorStyle` in `TableRowsProperties` is not cosmetic. It
converts the Table's last row into a footer and **overwrites that row's cells
with aggregations**. In the isolated trial, a row reading

```
Oren Whitfield | Clay & Kiln | Pending | 6 | =D5*55
```

came back as

```
Oren Whitfield | Clay & Kiln | Pending | =SUM(T[Sessions]) | =SUM(T[Fee])
```

The identical trial without `footerColorStyle` left the row untouched. Real data
was replaced by formulas, with no error and no warning, from a field that reads
like a color. `sheets_table` must not send this field as part of a preset, and if
a footer is ever offered it has to be an explicit, documented request that says
the last row becomes a totals row.

### `appendCells` with `tableId` silently discards the values

This is the finding that changes the tool surface. Four append paths were tried
against the same Table shape, each appending one fully populated row:

| Path | Values land | Table range grows |
|---|---|---|
| `appendCells` + `tableId`, `fields: 'userEnteredValue'` | **no** | yes |
| `appendCells` + `tableId`, `fields: '*'` | **no** | yes |
| `appendCells` + `sheetId` | yes | **no** |
| `values.append` over the Table's range, `INSERT_ROWS` | yes | yes |

`appendCells` with `tableId` returns success, grows the Table by one row, and
writes an empty row. The row values are dropped on both field masks. The
`sheetId` form writes the values correctly but the new row falls outside the
Table, so the Table stops covering its own data.

**`values.append` with `INSERT_ROWS` over the Table's range is the only path that
both writes the values and extends the Table.** That is what `sheets_write
append` should use on a Table, and the Tool surface entries naming
`appendCells(tableId)` should be corrected.

### Table DROPDOWN validation does not live on the cells

Reading `dataValidation` on the cells of a Table's DROPDOWN column returns
nothing. The rule lives on the Table's `columnProperties`, not on the cells. Any
code that detects dropdowns, including `sheets_open`'s `ui_owned` reporting and
the lint rules, has to read `sheets.tables` as well as cell-level validation, or
it will report a typed Table column as having no dropdown.

### Table banding does not override explicit cell fills

A cell given a distinctive fill before the Table existed kept that fill
afterwards, overriding the Table's band color for that cell, while its neighbours
banded normally. The rendered PNG shows one lilac cell in an otherwise clean
green-banded Table. So adopting a Table over a range a human has hand-colored
produces a visibly patchy result. `sheets_table adopt` should detect explicit
cell fills inside the range and either report them or offer to clear them, rather
than assuming the band colors will win.

## Spike 4, chip colors: SETTLED, the rewrite wipes them

**Script:** `spikes/spike4-chip-colors.mjs`, two phases. Jordan performed the UI
step on 2026-09-07 and `verify` ran against it.

**Verdict: `setDataValidation` with a byte-identical condition destroys the
option colors a human set in the UI.** The plan's rule that the plugin must never
rewrite a `ui_owned` validation rule without `force` is correct and now has
evidence behind it.

The rewrite sent a condition built from the same constant the setup used, so it
was provably identical to what the API had already written. The colors still went
away.

### The evidence

Three renders of the same six-row tab, in order:

| PNG | What is visible |
|---|---|
| `spikes/out/spike4-before-ui-colors-1.png` | API-created dropdown. All six statuses in plain black text. |
| `spikes/out/spike4-after-ui-colors-1.png` | After Jordan's edit. `Confirmed` renders green, `Declined` renders red, `Pending` stays black. |
| `spikes/out/spike4-after-rewrite-1.png` | After the identical rewrite. All six statuses black again. Cell values unchanged. |

`Pending` was deliberately left uncolored as a control, and it is black in all
three, which is what makes the middle image readable as color rather than as a
rendering artifact.

### The dangerous part: the API reports almost nothing

`spreadsheets.get` returns exactly three keys on a validation rule: `condition`,
`strict`, and `showCustomUi`. No color, no chip, no display style. The colors are
invisible to the API both before and after they are destroyed, so a plugin that
rewrites a rule gets a success response and no indication that it just wiped a
colleague's work.

The one API-visible difference across the whole episode was **option order**.
Before Jordan's edit the options read `Confirmed / Pending / Declined`, matching
what the API wrote. After the edit they read `Confirmed / Declined / Pending`.
The rewrite put them back to the API's order.

That is not a usable detection signal. With a single trial there is no way to
tell whether the reorder came from applying colors or from Jordan dragging the
options while in the panel, and a human who colors options without reordering
them would leave no trace at all. **So `ui_owned` cannot be inferred by
inspecting a rule.** It has to come from provenance: the plugin knows which rules
it created, through the registry and the column metadata, and treats everything
else as human-owned. That is what the plan already does, and this spike says
there is no cheaper shortcut available.

### One thing this does not establish

Whether the colors are lost on *any* `setDataValidation` touching that range, or
only when the written condition differs in option order from the stored one, was
not separated. The rewrite here did both at once: it wrote an identical condition
and it reordered the options back. Since the plugin's rule is "never rewrite a
human's rule without `force`" either way, the distinction does not change the
design, but it should not be stated as known.

## Spike 5, metadata visibility: GO

**Scripts:** `spikes/spike5-metadata.mjs`, `spikes/spike5b-metadata-masks.mjs`.

**PROJECT-visibility metadata on a column works and is durable.** Written against
a column dimension, it read back through `developerMetadata.search` with its
value and location intact.

**It tracks the column, not the index.** After inserting a column to its left,
the metadata's `startIndex` moved from 1 to 2 and still pointed at the
`Instructor` header. Column metadata rides the dimension exactly as the plan
hopes, so a shifted column does not orphan its contract.

**It survives a copy, which the plan says it does not.** `drive.files.copy`, the
API equivalent of File > Make a copy, produced a copy carrying the same metadata
entry, same id, same visibility, correct index. The plan's statement that
`sheets_open` must say "no contract" because Make a copy drops metadata is not
supported by this evidence and should be removed. The UI's Make a copy is a
different code path than `files.copy`, so it is worth one manual check before the
claim is reversed in the docs, but the API-side behavior is clear.

**Reading it back needs the right call.** `spreadsheets.get` with
`developerMetadata` in the mask returns nothing for column metadata. Each
location type surfaces on a different field path:

| Location | Mask that finds it |
|---|---|
| Spreadsheet | `developerMetadata` |
| Sheet | `sheets.developerMetadata` |
| Column | `sheets.data.columnMetadata.developerMetadata`, and only with `ranges` supplied |

`developerMetadata.search` with a key lookup returns **all three in one call**,
each tagged with its `locationType`. That is what `sheets_open` should use.
Chasing it through `spreadsheets.get` costs three field paths and a `ranges`
argument for no benefit.

**Not testable here.** Whether a second Desktop OAuth client in the same GCP
project can read PROJECT metadata written by the VM's client needs two distinct
OAuth clients. One token exists, so this spike cannot answer it, and
cross-client visibility must not be treated as verified. If it turns out to fail,
DOCUMENT visibility is the fallback and was confirmed working here; the cost is
that any client opening the file can see the contract.

## Spike 6, stateless HTTP: GO

**Script:** `spikes/spike6-stateless-http.mjs`. No Google credentials needed.

The production aggregator does not perform an MCP handshake per request. It POSTs
a bare `tools/call` with an arbitrary JSON-RPC id and no prior `initialize`, many
at once. The spike reproduces that against a minimal
`@modelcontextprotocol/sdk` 1.30.0 server on `StreamableHTTPServerTransport` with
`sessionIdGenerator: undefined` and `enableJsonResponse: true`. Ids are a mix of
strings and numbers, non-sequential, and one is deliberately reused across two
independent calls.

| Mode | Requests | Succeeded | Ids echoed correctly |
|---|---|---|---|
| Fresh transport + `McpServer` per request, concurrent | 20 | 20 | yes |
| Same, at higher load | 50 | 50 | yes |
| One transport reused, concurrent | 20 | 1 | no |
| One transport reused, sequential | 20 | 1 | no |

**What holds.** Per-request construction is correct under concurrency. Every
response came back `200 application/json` with the caller's own id echoed, and
the duplicate id caused no cross-talk. Module-scope state shared across those
per-request instances behaved exactly as the plan wants: 50 tool invocations
landed on one shared counter and one shared cache, which is where the Google
client and the sheet-name cache will live. Maximum latency at 50 concurrent was
69 ms, so per-request construction is not a throughput concern.

**Reuse is worse than the plan assumed.** The plan says a stateless transport
"cannot be reused across requests," which reads like a concurrency hazard. It is
not. Reuse fails on the second request even when requests are strictly
sequential. Exactly one request per transport ever succeeds.

**The failure is silent, which is the part that matters.** A reused transport
returns no JSON-RPC error. Sequential reuse produces an HTTP 500 with an empty
body; concurrent reuse destroys the socket and the client sees `ECONNRESET`.
Neither `transport.onerror` nor `server.onerror` fires, so nothing is logged
server-side either. A server that got this wrong would look healthy in its own
logs while failing almost every call.

**Consequences.** Construct the transport and the `McpServer` inside the request
handler, close both on response close, keep the Google client and caches at
module scope, and never add a "reuse the transport when idle" optimization. The
offline suite needs a case firing two sequential requests at one server and
asserting both return a result.

## Other things worth knowing

- **`addBanding` is not idempotent and `updateCells` does not clear banding.**
  Re-running a build over a tab that already has a banded range fails with "You
  cannot add alternating background colors to a range that already has
  alternating background colors." Clearing a tab properly means deleting tables,
  the basic filter, banded ranges, conditional-format rules (by index, from the
  end), and merges explicitly, then `updateCells`. `spikes/lib/auth.mjs`
  `resetTab` does all of it and is a good model for `sheets_style clear`.
- **Conditional-format rules are addressed by index and shift as you delete
  them**, which is exactly why the plan's fingerprint addressing for
  `sheets_conditional_format` is the right call.
- **A stored Python `google-auth` token's `token` field is a trap.** Seeding it
  into `OAuth2Client.setCredentials` without an `expiry_date` makes the library
  hand back the stale access token as if it were live. Every `googleapis` call
  still works, because that layer refreshes on 401, but any raw-bearer call
  (the export URL) gets a 401 and an HTML page. Set only `refresh_token` and let
  the library mint a fresh one. This will bite `src/lib/auth.ts`, which has to
  tolerate exactly this token shape.
- **`TableColumnDataValidationRule` carries only `condition`.** Unlike
  `DataValidationRule` it has no `showCustomUi`, `strict`, or `inputMessage`, so
  a Table column cannot carry help text the way a plain range rule can.
- **A Table column type strips the number format pattern from its cells.**
  Writing `{type: CURRENCY, pattern: "\"$\"#,##0;(\"$\"#,##0);\"-\""}` into a
  CURRENCY column of a Table reads back as `{type: CURRENCY}` with the pattern
  gone, and the cell renders in the locale default (`$1,234.50`). The identical
  `repeatCell` on a cell one column outside the Table keeps its pattern and
  renders `$1,235`. So a preset's number patterns cannot reach a typed Table
  column, and `sheets_table` does not send them: it says the column type governs
  the display instead. Patterns still apply everywhere outside a Table.
- **`TableRowsProperties` accepts and returns `ColorStyle.themeColor`.** A Table
  created with `headerColorStyle: {themeColor: "ACCENT1"}` reads back as that
  slot, and the header cell's `effectiveFormat.backgroundColorStyle` is the slot
  too, so a Table painted from a preset follows Format > Theme rather than
  freezing hex into the sheet.
- The discovery doc used throughout is revision **20260831**, matching the plan.

## Files

| Path | What it is |
|---|---|
| `spikes/package.json` | Spike-only dependencies, separate from the root package |
| `spikes/fetch-secrets.mjs` | Pulls the OAuth secrets into `spikes/.secrets/`, prints byte counts only |
| `spikes/lib/auth.mjs` | Token loading, the disposable spreadsheet, `resetTab`, granted-scope reporting |
| `spikes/lib/render.mjs` | Export URL builder, redirect handling, `pdftoppm`, Drive fallback |
| `spikes/spike1-render.mjs` | Spike 1: build the tab, render four ways |
| `spikes/spike1b-redirect-auth.mjs` | Spike 1: does the redirect hop need the bearer |
| `spikes/spike3-tables.mjs` | Spike 3: the five Table questions |
| `spikes/spike3b-append-isolate.mjs` | Spike 3: isolate `footerColorStyle` and the empty append |
| `spikes/spike3c-append-variants.mjs` | Spike 3: four append paths compared |
| `spikes/spike4-chip-colors.mjs` | Spike 4, `setup` and `verify` phases |
| `spikes/spike5-metadata.mjs` | Spike 5: write, read, column insert, copy |
| `spikes/spike5b-metadata-masks.mjs` | Spike 5: which field mask finds which location type |
| `spikes/spike6-stateless-http.mjs` | Spike 6 |

`spikes/.secrets/` and `spikes/out/` are gitignored. Reports and PNGs land in
`spikes/out/`.

## The spike spreadsheet

One disposable spreadsheet titled **gsheets-pro spike (safe to delete)** holds
every tab these spikes created. Tabs: `Spike1 Render`, `Spike1 Long`,
`Spike3 Tables`, `Spike3b NoFooter`, `Spike3b Footer`, `Spike3c v1` to `v4`,
`Spike4 Chips`, `Spike5 Metadata`, `Spike5b Masks`. All data in it is invented.

```
https://docs.google.com/spreadsheets/d/17cxldiVI3brpJaWc3pBylTauKa7Vii7w8MDkMw_vR-Y/edit
```

Every spike is now resolved, so nothing depends on this sheet any more and it can
be deleted whenever Jordan likes. The one reason to keep it a little longer is
that `Spike4 Chips` is the only place a human-colored dropdown exists, which
makes it a convenient fixture if the chip question ever needs re-testing.

**Delete this section before publication.** The Phase 7 gate greps for
spreadsheet ids, and this one would trip it.
