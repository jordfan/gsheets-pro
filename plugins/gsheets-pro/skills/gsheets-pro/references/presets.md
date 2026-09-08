# Presets and archetypes

A preset is the answer to "what color is a header". Its job is to keep hex
values out of the model's decisions, so a sheet looks deliberate rather than
assembled from whatever seemed reasonable at each call.

## Two independent axes

**Preset** is the palette and the fonts. Three ship: `neutral` (the default),
`park`, and `finance-classic`.

**Archetype** is what the colors mean. Two exist, and they cut across every
preset.

`tracker` is the default. Text is black. State lives in a Status column with
real words in it, painted by a dropdown chip or a conditional rule. Rows are
banded, the header is frozen, there is a Check column. This is the right shape
for a roster, a schedule, an onboarding tracker, anything a group of people
maintain together.

`model` follows the financial-modelling convention. Font color encodes data
role: blue for a typed input, black for a formula on this sheet, green for one
reading another tab. Banding is off, because banding and a font-color language
fight each other for the reader's attention. Key assumptions get a fill. This is
the right shape for a budget or a projection, where a reviewer's first question
is always which numbers were assumed.

Do not mix them. A sheet with both blue inputs and status banding has two color
systems and no legible one.

## How a preset becomes a spreadsheet

`sheets_style` with a `preset` and no range writes the workbook theme:
`updateSpreadsheetProperties` carrying the full `SpreadsheetTheme` plus
`primaryFontFamily`. The Sheets API rejects a partial theme write, so all nine
pairs go every time; the tool reads the current theme first and fills any slot
the preset does not name.

The nine slots are `TEXT`, `BACKGROUND`, `ACCENT1` through `ACCENT6`, and
`LINK`.

Everything downstream resolves through them. A role that maps to a slot compiles
to `ColorStyle.themeColor`, so the cell references the theme rather than a
frozen hex value. The consequence is the point of the whole system: applying a
different preset re-skins headers, banding, borders, and conditional formats
without touching a single cell's contents.

A role with no natural slot, such as the second banding color or the soft
`ok`/`warn`/`flag` fills, compiles to `rgbColor`. Those are the colors that do
not re-skin, which is why the presets keep them few.

## The role tokens

| Token | Where it lands |
|---|---|
| `title` | A title banner above a table. Carries the display font and its own size |
| `header.fill`, `header.text` | The Table header row |
| `band1`, `band2` | Alternating row banding |
| `input` | Font color for a typed cell (`model` archetype only) |
| `formula` | Font color for a calculated cell (`model` archetype only) |
| `cross_sheet` | Font color for a formula reading another tab |
| `ok`, `warn`, `flag` | Status fills, applied only by conditional rule or chip |
| `muted` | Secondary text: footnotes, source lines, units |

Plus `numbers` (currency, percent, date, integer, decimal, multiple) and `tabs`
(inputs, workings, outputs), which colors a tab by its role so the three-way
separation of inputs, workings, and outputs is visible before anyone opens
anything.

**There is no footer token, and the schema will not let you add one.** A Table's
`footerColorStyle` reads like a color and behaves like a data migration: setting
it turns the last data row into a footer and overwrites that row's cells with
`SUM` formulas, destroying whatever was there, with no error. So a preset styles
the header and the bands and stops. If a totals row is genuinely wanted, it is
asked for in those words, and the safe shape is a summary block above the Table
or on another tab. `references/limitations.md` has the evidence.

## Writing your own

Copy `presets/neutral.json`, change the values, drop it beside the others. The
shape is `presets/schema.json`.

The loader validates three things and refuses the preset rather than shipping a
sheet that fails them:

- **Contrast.** Header fill against header text must reach 4.5 to 1. This is the
  WCAG AA threshold for normal text, and a header is normal text.
- **Banding separation.** `band1` and `band2` must differ enough to read as
  bands. Two nearly identical greys are worse than no banding, because they look
  like a rendering artifact.
- **Fonts.** Anything in the preset's own `banned` list is refused as primary or
  display. That list is how a house style stays off the defaults everyone else
  lands on.

Two things worth knowing before you pick colors. A font Google Sheets does not
offer falls back to Arial silently, so check the font picker before committing
to one. And a display face belongs in a title only; grid data in a serif at
10 point is harder to read, and readability is the entire product here.

## The three that ship

**`neutral`.** Slate blue and greys, Arial, tracker archetype. Deliberately
belongs to nobody. When a request does not name a preset, this is what it gets.

**`park`.** A green house palette with EB Garamond titles over Open Sans body
text. Orange is held back for status and brick for flags, so a status column
stays legible against the greens. Bans Inter, Roboto, and Arial as primary,
which is the point of a house preset: it makes the defaults unavailable.

**`finance-classic`.** Blue inputs, black formulas, green cross-sheet links,
yellow fill on assumptions. Defaults to the `model` archetype and turns banding
off. This is the convention a financial reviewer already knows how to read, so
using it means their eyes go to the right cells without being told.

## Detection

`sheets_open` reports which preset a spreadsheet appears to use. On a sheet this
plugin built or adopted, that is read from developer metadata, and it is exact.
On any other sheet it is inferred from the theme and the fonts, and it may be
wrong. The tool says which of the two it did. When there is no match, it
describes the conventions it found instead: the fonts in use, the header
treatment, the date format. Match those. See `references/existing-sheets.md`.
