/**
 * `sheets_style`: how a sheet looks, in one call.
 *
 * Formatting is the thing every other Sheets MCP leaves out, and it is most of
 * what makes a spreadsheet read as a careful person's work. So it is one tool
 * taking one style object over one range, rather than a dozen verb-shaped
 * tools, and everything it does lands in a single `batchUpdate`.
 *
 * Three ideas run through it.
 *
 * **Colors are named, never guessed.** A call says `role: "header"` or
 * `background: "theme:ACCENT1"`. Roles resolve through the preset, and any
 * color that names one of the nine theme slots is written as
 * `ColorStyle.themeColor`, so Format > Theme stays the human's knob and
 * changing the preset re-skins the workbook without touching a cell.
 *
 * **With a preset and no range, this writes the workbook's theme.** All nine
 * pairs go every time, because the API rejects a partial theme, and slots the
 * preset does not name are inherited from the sheet rather than reset to
 * Google's defaults. It also records the preset in developer metadata, so the
 * next session knows what this spreadsheet is styled with instead of guessing
 * from the colors.
 *
 * **Restyling somebody else's spreadsheet is not a formatting decision.** A
 * theme, a banding, or a clear on a sheet the registry marks human or shared
 * changes how every tab looks, including the tabs nobody asked about, so those
 * need `force` and a `reason` that says who asked.
 *
 * Two refusals are structural rather than stylistic. A merge inside a Table or
 * a data region is refused, because merges break sorting, filtering, and any
 * formula that crosses them; a title banner above the table is the shape that
 * works. And there is no footer color anywhere in this tool, because a Table's
 * `footerColorStyle` converts the last data row into a footer and overwrites
 * it with SUM formulas (spike 3).
 */

import { z } from "zod";

import {
  a1ToGridRange,
  gridRangeToA1,
  parseA1,
  parseColumnSpan,
  parseRowSpan,
  toA1Reference,
  type GridRange,
  type NullableBounds,
  type RangeBounds,
} from "../lib/a1.js";
import { runBatchUpdate, withRetry } from "../lib/batch.js";
import { parseColorStyle, type ColorStyle } from "../lib/colors.js";
import { METADATA_KEYS, toMetadataEntries, type MetadataEntry } from "../lib/contract.js";
import { err, GsheetsError } from "../lib/errors.js";
import { buildFieldMask, pruneUndefined } from "../lib/fieldmask.js";
import {
  describeCheck,
  runErrorGate,
  withinGateCap,
  type GateCheck,
} from "../lib/errorgate.js";
import { resolveNumberFormat } from "../lib/numfmt.js";
import { assertWritable, type Policy } from "../lib/registry.js";
import { count, guarded, lines, listOf, ok, type ToolResponse } from "../lib/result.js";
import { resolveSpreadsheetId, SPREADSHEET_ID_DESCRIPTION } from "../lib/spreadsheetid.js";
import { recordWrite } from "../lib/writelog.js";
import {
  compileTheme,
  loadPreset,
  manifestValue,
  resolveArchetype,
  resolvePresetName,
  roleFormat,
  ROLE_TOKENS,
  type CellFormat,
  type CompiledTheme,
  type CurrentTheme,
} from "../lib/theme.js";
import type { ToolDefinition, ToolDeps } from "./types.js";

const BORDER_STYLES = ["SOLID", "SOLID_MEDIUM", "SOLID_THICK", "DASHED", "DOTTED", "DOUBLE", "NONE"] as const;
const BORDER_EDGES = ["top", "bottom", "left", "right", "inner_horizontal", "inner_vertical"] as const;

const STYLE_MASK = [
  "properties(title,spreadsheetTheme(primaryFontFamily,themeColors(colorType,color(rgbColor))))",
  "sheets.properties(sheetId,title,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount,hideGridlines))",
  "sheets.tables(tableId,name,range)",
  "sheets.bandedRanges(bandedRangeId,range)",
  "sheets.merges",
  "sheets.conditionalFormats(ranges)",
].join(",");

export const styleInputSchema = {
  spreadsheet_id: z.string().describe(SPREADSHEET_ID_DESCRIPTION),
  sheet: z
    .string()
    .optional()
    .describe("The tab name. Omit only when applying a preset theme to the whole spreadsheet."),
  range: z
    .string()
    .optional()
    .describe("A1 range the style applies to, for example A1:F1. Defaults to the whole tab when a style is given."),
  preset: z
    .string()
    .optional()
    .describe(
      "The palette. With no range this writes the spreadsheet's theme, all nine slots, and records the preset in the sheet's own metadata. With a range it just resolves the role tokens.",
    ),
  archetype: z
    .enum(["tracker", "model"])
    .optional()
    .describe(
      "tracker keeps font color out of the data language and carries state in dropdowns and conditional rules. model uses font color to encode input against formula. Taken from the preset when omitted.",
    ),
  style: z
    .object({
      role: z
        .enum(ROLE_TOKENS)
        .optional()
        .describe("A preset role: header, title, band1, band2, ok, warn, flag, muted, and on a model input, formula, cross_sheet."),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      strikethrough: z.boolean().optional(),
      underline: z.boolean().optional(),
      font: z.string().optional(),
      font_size: z.number().int().min(6).max(72).optional(),
      text_color: z.string().optional().describe("Hex, a color name, or a theme slot like theme:ACCENT1."),
      background: z.string().optional().describe("Hex, a color name, or a theme slot like theme:ACCENT1."),
      align: z.enum(["LEFT", "CENTER", "RIGHT"]).optional(),
      vertical_align: z.enum(["TOP", "MIDDLE", "BOTTOM"]).optional(),
      wrap: z.enum(["OVERFLOW_CELL", "CLIP", "WRAP"]).optional(),
      number_format: z
        .string()
        .optional()
        .describe("A preset key (currency, percent, date, integer, decimal, multiple), a shorthand, or a literal pattern."),
      note: z.string().optional().describe("A cell note, left on every cell of the range."),
    })
    .strict()
    .optional()
    .describe("One style object applied to the whole range. Only the properties named are touched."),
  borders: z
    .object({
      edges: z
        .union([z.literal("all"), z.literal("outer"), z.array(z.enum(BORDER_EDGES))])
        .describe("all, outer, or a list of top, bottom, left, right, inner_horizontal, inner_vertical."),
      style: z.enum(BORDER_STYLES).optional().describe("Default SOLID. NONE removes the named edges."),
      color: z.string().optional().describe("Hex, a color name, or a theme slot."),
    })
    .strict()
    .optional(),
  column_widths: z
    .array(z.object({ columns: z.string(), pixels: z.number().int().min(2).max(2000) }).strict())
    .optional()
    .describe('Column spans and their widths, for example [{ "columns": "B:D", "pixels": 140 }].'),
  row_heights: z
    .array(z.object({ rows: z.string(), pixels: z.number().int().min(2).max(2000) }).strict())
    .optional()
    .describe('Row spans and their heights, for example [{ "rows": "1", "pixels": 34 }].'),
  autofit: z
    .object({ columns: z.string().optional(), rows: z.string().optional() })
    .strict()
    .optional()
    .describe('Size to content, for example { "columns": "A:H" }.'),
  banding: z
    .object({
      range: z.string().optional().describe("Defaults to the call's range."),
      header: z.boolean().optional().describe("Paint the first row with the header role. Default true."),
      first: z.string().optional().describe("First band color. Defaults to the preset's band1."),
      second: z.string().optional().describe("Second band color. Defaults to the preset's band2."),
      remove: z.boolean().optional().describe("Delete the banding covering this range instead of adding one."),
    })
    .strict()
    .optional()
    .describe(
      "Alternating row colors. Adds a banding, or updates the one already covering the range, because a second banding over the same cells is refused by the API. There is no footer color and there cannot be one: it would overwrite the last data row with SUM formulas.",
    ),
  merge: z
    .object({
      range: z.string().optional(),
      type: z.enum(["MERGE_ALL", "MERGE_COLUMNS", "MERGE_ROWS"]).optional(),
    })
    .strict()
    .optional()
    .describe("Merge cells. Refused inside a Table or a data region, where merges break sorting and formulas."),
  unmerge: z
    .union([z.boolean(), z.object({ range: z.string() }).strict()])
    .optional()
    .describe("Unmerge everything in the range."),
  clear: z
    .object({
      formats: z.boolean().optional(),
      banding: z.boolean().optional(),
      conditional_formats: z.boolean().optional(),
      merges: z.boolean().optional(),
    })
    .strict()
    .optional()
    .describe(
      "Strip formatting back to plain. Formats alone will not remove banding, conditional rules, or merges, which is why each is named separately. Values are never touched.",
    ),
  freeze_rows: z.number().int().min(0).max(50).optional().describe("Rows frozen at the top. 1 for a header."),
  freeze_columns: z.number().int().min(0).max(50).optional(),
  gridlines: z.boolean().optional().describe("false hides the gridlines, which is what banding wants."),
  tab_color: z.string().optional().describe('A color, a theme slot, or "none" to clear it.'),
  force: z
    .boolean()
    .optional()
    .describe("Required, with reason, to restyle a spreadsheet the registry marks as somebody else's."),
  reason: z.string().optional().describe("Who asked for this restyle, in one sentence."),
  dry_run: z.boolean().optional().describe("Report the requests that would be sent and send nothing."),
  check: z.boolean().optional().describe("Read the styled range back and report whether it evaluates. Default true."),
};

type StyleArgs = {
  spreadsheet_id: string;
  sheet?: string;
  range?: string;
  preset?: string;
  archetype?: "tracker" | "model";
  style?: Record<string, unknown>;
  borders?: { edges: string | string[]; style?: string; color?: string };
  column_widths?: Array<{ columns: string; pixels: number }>;
  row_heights?: Array<{ rows: string; pixels: number }>;
  autofit?: { columns?: string; rows?: string };
  banding?: { range?: string; header?: boolean; first?: string; second?: string; remove?: boolean };
  merge?: { range?: string; type?: string };
  unmerge?: boolean | { range: string };
  clear?: { formats?: boolean; banding?: boolean; conditional_formats?: boolean; merges?: boolean };
  freeze_rows?: number;
  freeze_columns?: number;
  gridlines?: boolean;
  tab_color?: string;
  force?: boolean;
  reason?: string;
  dry_run?: boolean;
  check?: boolean;
};

/** Anything here restyles rather than adds, so it needs force on a shared sheet. */
const RESTYLE_KEYS: ReadonlyArray<keyof StyleArgs> = ["preset", "banding", "clear"];

export function createStyleTool(deps: ToolDeps): ToolDefinition<typeof styleInputSchema> {
  return {
    name: "sheets_style",
    config: {
      title: "Style a sheet",
      description:
        "Formatting in one call: a style object over a range, borders, column widths and row heights, autofit, banding, merges, freezing, gridlines, and tab color. With a preset and no range it writes the spreadsheet's theme so every color the plugin paints follows Format > Theme. Refuses a merge inside a Table or a data region, and needs force plus a reason to restyle a spreadsheet somebody else owns.",
      inputSchema: styleInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    handler: guarded(async (raw: Record<string, unknown>): Promise<ToolResponse> => {
      const args = raw as StyleArgs;
      const ctx = await deps.getContext();
      const spreadsheetId = resolveSpreadsheetId(args.spreadsheet_id);

      const wantsTheme = !!args.preset && !args.range && !args.style;
      const warnings: string[] = [];

      // One masked read gives everything the requests need: the current theme
      // for the slots a preset leaves out, the Tables and merges the merge
      // guard consults, and the banding ids that decide add against update.
      const surface = await readSurface(ctx, spreadsheetId, args.sheet);
      const policy = ctx.registry?.policyFor(spreadsheetId, args.sheet);

      assertWritable(policy, { tool: "sheets_style", ...(args.force ? { force: true } : {}) });
      assertRestyleAllowed(args, policy, surface.spreadsheetTitle);

      const compiled = args.preset || args.style?.["role"] || args.banding
        ? compilePreset(args, surface, policy)
        : undefined;
      if (compiled) warnings.push(...compiled.warnings);

      const requests: unknown[] = [];
      const touchedRanges: string[] = [];
      const did: string[] = [];

      // Read once and reuse. Developer metadata has no upsert, so writing the
      // manifest without knowing what is already there piles up a duplicate
      // entry on every theme call.
      const existingMetadata = wantsTheme ? await readMetadata(ctx, spreadsheetId) : [];

      if (wantsTheme) {
        if (!compiled) throw err.internal("A theme write reached the builder with no compiled preset.");
        requests.push({
          updateSpreadsheetProperties: {
            properties: { spreadsheetTheme: compiled.spreadsheetTheme },
            fields: "spreadsheetTheme",
          },
        });
        did.push(
          `applied the ${compiled.preset.name} theme, all nine slots, in ${compiled.spreadsheetTheme.primaryFontFamily}`,
        );
        if (compiled.inheritedSlots.length) {
          warnings.push(
            `The preset named no color for ${listOf(compiled.inheritedSlots)}, so the spreadsheet's existing ${compiled.inheritedSlots.length === 1 ? "value was" : "values were"} kept.`,
          );
        }
        requests.push(manifestRequest(compiled, existingMetadata));
        did.push("recorded the preset in the spreadsheet's own metadata");
      }

      // Everything below needs a tab.
      if (!wantsTheme || args.sheet) {
        const sheet = requireSheet(args, surface);
        const sheetId = sheet.sheetId;
        const sheetName = sheet.title;
        const baseRange = args.range?.trim();

        if (args.clear) {
          const bounds = baseRange ? parseA1(baseRange) : {};
          requests.push(...clearRequests(args.clear, sheetId, bounds, sheet));
          did.push(
            `cleared ${listOf(
              [
                args.clear.formats !== false ? "formatting" : undefined,
                args.clear.banding ? "banding" : undefined,
                args.clear.conditional_formats ? "conditional format rules" : undefined,
                args.clear.merges ? "merges" : undefined,
              ].filter((s): s is string => !!s),
            )} on ${baseRange ?? "the whole tab"}`,
          );
          if (baseRange) touchedRanges.push(toA1Reference(sheetName, baseRange));
        }

        if (args.style) {
          const format = buildCellFormat(args.style, compiled);
          const cell = pruneUndefined(format.cell);
          const fields = buildFieldMask(cell);
          if (!fields) {
            throw err.invalid(
              "style was passed with nothing in it.",
              "Name at least one of role, bold, background, text_color, align, wrap, number_format, or note.",
            );
          }
          requests.push({
            repeatCell: { range: gridRange(sheetId, baseRange), cell, fields },
          });
          did.push(
            `styled ${baseRange ?? "the whole tab"}${format.role ? ` with the ${format.role} role` : ""}`,
          );
          if (baseRange) touchedRanges.push(toA1Reference(sheetName, baseRange));
        }

        if (args.borders) {
          requests.push(borderRequest(args.borders, sheetId, baseRange));
          did.push(`set borders on ${baseRange ?? "the whole tab"}`);
        }

        for (const entry of args.column_widths ?? []) {
          const span = parseColumnSpan(entry.columns);
          requests.push({
            updateDimensionProperties: {
              range: { sheetId, dimension: "COLUMNS", startIndex: span.startIndex, endIndex: span.endIndex },
              properties: { pixelSize: entry.pixels },
              fields: "pixelSize",
            },
          });
        }
        if (args.column_widths?.length) {
          did.push(`set ${count(args.column_widths.length, "column width")}`);
        }

        for (const entry of args.row_heights ?? []) {
          const span = parseRowSpan(entry.rows);
          requests.push({
            updateDimensionProperties: {
              range: { sheetId, dimension: "ROWS", startIndex: span.startIndex, endIndex: span.endIndex },
              properties: { pixelSize: entry.pixels },
              fields: "pixelSize",
            },
          });
        }
        if (args.row_heights?.length) did.push(`set ${count(args.row_heights.length, "row height")}`);

        if (args.autofit?.columns) {
          const span = parseColumnSpan(args.autofit.columns);
          requests.push({
            autoResizeDimensions: {
              dimensions: { sheetId, dimension: "COLUMNS", startIndex: span.startIndex, endIndex: span.endIndex },
            },
          });
          did.push(`sized columns ${args.autofit.columns} to their content`);
        }
        if (args.autofit?.rows) {
          const span = parseRowSpan(args.autofit.rows);
          requests.push({
            autoResizeDimensions: {
              dimensions: { sheetId, dimension: "ROWS", startIndex: span.startIndex, endIndex: span.endIndex },
            },
          });
          did.push(`sized rows ${args.autofit.rows} to their content`);
        }

        if (args.banding) {
          const result = bandingRequests(args.banding, sheetId, baseRange, sheet, compiled);
          requests.push(...result.requests);
          did.push(result.description);
          warnings.push(...result.warnings);
        }

        if (args.merge) {
          const mergeRange = args.merge.range ?? baseRange;
          if (!mergeRange) {
            throw err.invalid(
              "merge needs a range.",
              "Pass range, or merge.range, naming the cells to merge, for example A1:F1.",
            );
          }
          assertMergeAllowed(mergeRange, sheet, args.force === true, sheetName);
          requests.push({
            mergeCells: {
              range: gridRange(sheetId, mergeRange),
              mergeType: args.merge.type ?? "MERGE_ALL",
            },
          });
          did.push(`merged ${mergeRange}`);
        }

        if (args.unmerge) {
          const unmergeRange =
            typeof args.unmerge === "object" ? args.unmerge.range : baseRange;
          requests.push({ unmergeCells: { range: gridRange(sheetId, unmergeRange) } });
          did.push(`unmerged ${unmergeRange ?? "the whole tab"}`);
        }

        const sheetProperties = sheetPropertyRequest(args, sheetId, compiled);
        if (sheetProperties) {
          requests.push(sheetProperties.request);
          did.push(...sheetProperties.described);
        }

        // Only the theme path records what a tab is. A call that paints one
        // range with the park header color is not a statement that this tab is
        // a park tracker, and recording it as one would make the contract a
        // guess rather than a record.
        if (wantsTheme && compiled) {
          requests.push(sheetMetadataRequest(compiled, sheetId, existingMetadata));
        }
      }

      if (requests.length === 0) {
        throw err.invalid(
          "sheets_style was called with nothing to do.",
          "Pass a style, borders, column_widths, row_heights, autofit, banding, merge, unmerge, clear, freeze_rows, freeze_columns, gridlines, tab_color, or a preset.",
        );
      }

      if (args.dry_run) {
        return ok(
          lines(
            `Dry run. Nothing was changed.`,
            `Would send ${count(requests.length, "request")} in one batchUpdate: ${listOf(did)}.`,
            warnings.length ? `\nWorth knowing:\n${warnings.map((w) => `- ${w}`).join("\n")}` : undefined,
          ),
          {
            spreadsheet_id: spreadsheetId,
            dry_run: true,
            request_count: requests.length,
            requests,
            actions: did,
            warnings,
          },
        );
      }

      const batch = await runBatchUpdate(ctx.sheets as never, spreadsheetId, requests);
      ctx.cache.invalidate(spreadsheetId);

      // Formatting a human's column is still this session touching it, so it
      // goes in the ledger even though the gate may decline to read it back.
      for (const range of touchedRanges) {
        recordWrite({
          spreadsheetId,
          range,
          ...(args.sheet ? { sheet: args.sheet } : {}),
          tool: "sheets_style",
        });
      }

      const gateRanges = touchedRanges.filter((range) => {
        const bounds = safeBounds(range);
        return bounds ? withinGateCap(bounds) : false;
      });
      const check: GateCheck =
        args.check === false || gateRanges.length === 0
          ? await runErrorGate(ctx.sheets as never, spreadsheetId, [], {
              skip:
                args.check === false
                  ? "check was false."
                  : "Styling does not change what a cell computes, and no bounded range was styled, so nothing was read back. Run sheets_check before calling the work done.",
            })
          : await runErrorGate(ctx.sheets as never, spreadsheetId, gateRanges);

      const structured: Record<string, unknown> = {
        spreadsheet_id: spreadsheetId,
        sheet: args.sheet ?? null,
        preset: compiled ? compiled.preset.name : null,
        archetype: compiled ? compiled.archetype : null,
        request_count: batch.requestCount,
        actions: did,
        theme_applied: wantsTheme,
        check,
        warnings,
      };

      return ok(
        lines(
          `${surface.spreadsheetTitle}: ${listOf(did)}, in one batchUpdate of ${count(batch.requestCount, "request")}.`,
          compiled && wantsTheme
            ? `Colors that name a theme slot were written as theme references, so changing Format > Theme re-skins them.`
            : undefined,
          check.status === "skipped" ? undefined : describeCheck(check),
          warnings.length ? `\nWorth knowing:\n${warnings.map((w) => `- ${w}`).join("\n")}` : undefined,
        ),
        structured,
      );
    }),
  };
}

// ---------------------------------------------------------------------------
// Reading the sheet as it stands
// ---------------------------------------------------------------------------

interface SheetSurface {
  sheetId: number;
  title: string;
  frozenRowCount: number;
  frozenColumnCount: number;
  hideGridlines: boolean;
  tables: Array<{ tableId: string; name?: string; bounds: NullableBounds }>;
  bandedRanges: Array<{ bandedRangeId: number; bounds: NullableBounds }>;
  merges: NullableBounds[];
  conditionalFormatCount: number;
}

interface StyleSurface {
  spreadsheetTitle: string;
  currentTheme?: CurrentTheme;
  sheets: SheetSurface[];
}

async function readSurface(
  ctx: Awaited<ReturnType<ToolDeps["getContext"]>>,
  spreadsheetId: string,
  sheet: string | undefined,
): Promise<StyleSurface> {
  const response = await withRetry(() =>
    ctx.sheets.spreadsheets.get({ spreadsheetId, fields: STYLE_MASK }),
  );
  const data = response.data;
  const sheets: SheetSurface[] = (data.sheets ?? []).flatMap((s) => {
    const properties = s.properties;
    if (!properties?.title || properties.sheetId === undefined || properties.sheetId === null) return [];
    const grid = properties.gridProperties ?? {};
    return [
      {
        sheetId: properties.sheetId,
        title: properties.title,
        frozenRowCount: grid.frozenRowCount ?? 0,
        frozenColumnCount: grid.frozenColumnCount ?? 0,
        hideGridlines: grid.hideGridlines === true,
        tables: (s.tables ?? []).map((t) => ({
          tableId: t.tableId ?? "",
          ...(t.name ? { name: t.name } : {}),
          bounds: (t.range ?? {}) as NullableBounds,
        })),
        bandedRanges: (s.bandedRanges ?? []).flatMap((b) =>
          b.bandedRangeId === undefined || b.bandedRangeId === null
            ? []
            : [{ bandedRangeId: b.bandedRangeId, bounds: (b.range ?? {}) as NullableBounds }],
        ),
        merges: (s.merges ?? []) as NullableBounds[],
        conditionalFormatCount: (s.conditionalFormats ?? []).length,
      },
    ];
  });

  if (sheet) {
    const wanted = sheet.trim().toLowerCase();
    if (!sheets.some((s) => s.title.toLowerCase() === wanted)) {
      throw err.sheetNotFound(sheet, sheets.map((s) => s.title));
    }
  }

  const surface: StyleSurface = {
    spreadsheetTitle: data.properties?.title ?? "This spreadsheet",
    sheets,
  };
  if (data.properties?.spreadsheetTheme) surface.currentTheme = data.properties.spreadsheetTheme;
  return surface;
}

function requireSheet(args: StyleArgs, surface: StyleSurface): SheetSurface {
  if (!args.sheet) {
    throw err.invalid(
      "sheet is required for anything but a spreadsheet-wide theme.",
      "Pass the tab name. A preset with no range and no sheet writes the workbook theme, which is the only call that needs no tab.",
    );
  }
  const wanted = args.sheet.trim().toLowerCase();
  const hit = surface.sheets.find((s) => s.title.toLowerCase() === wanted);
  if (!hit) throw err.sheetNotFound(args.sheet, surface.sheets.map((s) => s.title));
  return hit;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function assertRestyleAllowed(args: StyleArgs, policy: Policy | undefined, title: string): void {
  const owner = policy?.owner;
  if (owner !== "human" && owner !== "shared") return;

  const restyling = RESTYLE_KEYS.filter((key) => args[key] !== undefined);
  // A Table-scale restyle is a banding or a theme over a whole tab, which is
  // the same thing by another route.
  if (args.style && !args.range) restyling.push("style");
  if (restyling.length === 0) return;

  if (args.force !== true || !args.reason?.trim()) {
    throw new GsheetsError(
      "needs_confirmation",
      `${policy?.name ?? title} is ${owner} owned, and ${listOf(restyling.map(String))} ${restyling.length === 1 ? "changes" : "change"} how it looks for everybody who uses it.`,
      "Applying a theme, a banding, or a tab-wide style to somebody else's spreadsheet changes tabs nobody asked about. If a person asked for this, pass force: true and reason saying who asked. If they asked for one range, pass that range instead.",
      { owner, restyling: restyling.map(String) },
    );
  }
}

/**
 * A merge inside a Table or a data region is refused.
 *
 * Merged cells break sorting, break filtering, and break any formula whose
 * range crosses them, and the damage shows up later in somebody else's work
 * rather than here. The shape that works is a title banner in the rows above
 * the table, which is why the refusal names it.
 */
function assertMergeAllowed(
  range: string,
  sheet: SheetSurface,
  force: boolean,
  sheetName: string,
): void {
  const bounds = parseA1(range);

  for (const table of sheet.tables) {
    if (!overlaps(bounds, table.bounds)) continue;
    if (force) return;
    throw new GsheetsError(
      "contract_violation",
      `${range} overlaps the native Table${table.name ? ` "${table.name}"` : ""} on ${sheetName}.`,
      "A merge inside a Table breaks sorting, filtering, and every structured reference that crosses it. Put the title in a row above the Table and merge there instead.",
      { table: table.name ?? table.tableId, table_range: gridRangeToA1(table.bounds) },
    );
  }

  // Below the frozen header is the data region on any tab that has one.
  const frozen = sheet.frozenRowCount;
  const startRow = bounds.startRowIndex ?? 0;
  if (frozen > 0 && startRow >= frozen && !force) {
    throw new GsheetsError(
      "contract_violation",
      `${range} is inside the data region on ${sheetName}, below the ${count(frozen, "frozen header row")}.`,
      "Merges in a data region break sorting and filtering. Merge a title banner above the header instead, or centre the text across the cells without merging them.",
    );
  }
}

function overlaps(a: NullableBounds, b: NullableBounds): boolean {
  const axis = (
    aStart: number | null | undefined,
    aEnd: number | null | undefined,
    bStart: number | null | undefined,
    bEnd: number | null | undefined,
  ): boolean => {
    const s1 = aStart ?? 0;
    const e1 = aEnd ?? Number.MAX_SAFE_INTEGER;
    const s2 = bStart ?? 0;
    const e2 = bEnd ?? Number.MAX_SAFE_INTEGER;
    return s1 < e2 && s2 < e1;
  };
  return (
    axis(a.startRowIndex, a.endRowIndex, b.startRowIndex, b.endRowIndex) &&
    axis(a.startColumnIndex, a.endColumnIndex, b.startColumnIndex, b.endColumnIndex)
  );
}

// ---------------------------------------------------------------------------
// The preset
// ---------------------------------------------------------------------------

function compilePreset(
  args: StyleArgs,
  surface: StyleSurface,
  policy: Policy | undefined,
): CompiledTheme {
  const resolved = resolvePresetName({
    ...(args.preset ? { argument: args.preset } : {}),
    ...(policy?.preset ? { registry: policy.preset } : {}),
  });
  const preset = loadPreset(resolved.name);
  const archetype = resolveArchetype(preset, {
    ...(args.archetype ? { argument: args.archetype } : {}),
    ...(policy?.archetype ? { registry: policy.archetype } : {}),
  });
  return compileTheme(preset, {
    archetype,
    ...(surface.currentTheme ? { current: surface.currentTheme } : {}),
  });
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

function gridRange(sheetId: number, range: string | undefined): GridRange {
  return a1ToGridRange(range, sheetId);
}

function buildCellFormat(
  style: Record<string, unknown>,
  compiled: CompiledTheme | undefined,
): { cell: Record<string, unknown>; role?: string } {
  const role = typeof style["role"] === "string" ? (style["role"] as string) : undefined;
  let format: CellFormat = {};
  if (role) {
    if (!compiled) {
      throw err.internal("A role was requested with no preset compiled.");
    }
    format = structuredClone(roleFormat(compiled, role));
  }

  const textFormat: Record<string, unknown> = { ...(format.textFormat ?? {}) };
  const userEnteredFormat: Record<string, unknown> = {};
  if (format.backgroundColorStyle) userEnteredFormat["backgroundColorStyle"] = format.backgroundColorStyle;

  const set = <T>(key: string, value: T | undefined) => {
    if (value !== undefined) userEnteredFormat[key] = value;
  };
  const setText = <T>(key: string, value: T | undefined) => {
    if (value !== undefined) textFormat[key] = value;
  };

  setText("bold", style["bold"]);
  setText("italic", style["italic"]);
  setText("strikethrough", style["strikethrough"]);
  setText("underline", style["underline"]);
  setText("fontFamily", style["font"]);
  setText("fontSize", style["font_size"]);
  if (typeof style["text_color"] === "string") {
    textFormat["foregroundColorStyle"] = parseColorStyle(style["text_color"]);
  }
  if (typeof style["background"] === "string") {
    userEnteredFormat["backgroundColorStyle"] = parseColorStyle(style["background"]);
  }
  set("horizontalAlignment", style["align"]);
  set("verticalAlignment", style["vertical_align"]);
  set("wrapStrategy", style["wrap"]);
  if (typeof style["number_format"] === "string") {
    userEnteredFormat["numberFormat"] = resolveNumberFormatSpec(style["number_format"], compiled);
  }

  if (Object.keys(textFormat).length) userEnteredFormat["textFormat"] = textFormat;

  const cell: Record<string, unknown> = {};
  if (Object.keys(userEnteredFormat).length) cell["userEnteredFormat"] = userEnteredFormat;
  if (typeof style["note"] === "string") cell["note"] = style["note"];

  return role ? { cell, role } : { cell };
}

/** A preset numbers key, then a shorthand, then a literal pattern. */
function resolveNumberFormatSpec(spec: string, compiled: CompiledTheme | undefined) {
  const key = spec.trim().toLowerCase();
  const fromPreset = compiled?.numberFormats[key];
  if (fromPreset) return fromPreset;
  return resolveNumberFormat(spec);
}

function borderRequest(
  borders: NonNullable<StyleArgs["borders"]>,
  sheetId: number,
  range: string | undefined,
): unknown {
  const style = borders.style ?? "SOLID";
  const border =
    style === "NONE"
      ? { style: "NONE" }
      : {
          style,
          colorStyle: borders.color ? parseColorStyle(borders.color) : { themeColor: "TEXT" },
        };

  const wanted = new Set<string>();
  if (borders.edges === "all") {
    for (const edge of BORDER_EDGES) wanted.add(edge);
  } else if (borders.edges === "outer") {
    wanted.add("top");
    wanted.add("bottom");
    wanted.add("left");
    wanted.add("right");
  } else {
    for (const edge of borders.edges) wanted.add(edge);
  }

  const request: Record<string, unknown> = { range: gridRange(sheetId, range) };
  const map: Record<string, string> = {
    top: "top",
    bottom: "bottom",
    left: "left",
    right: "right",
    inner_horizontal: "innerHorizontal",
    inner_vertical: "innerVertical",
  };
  for (const edge of wanted) {
    const key = map[edge];
    if (key) request[key] = border;
  }
  return { updateBorders: request };
}

interface BandingResult {
  requests: unknown[];
  description: string;
  warnings: string[];
}

/**
 * Banding, added or updated.
 *
 * `addBanding` over a range that is already banded fails outright, so the
 * existing banded range is found and updated instead. There is no footer
 * color: `footerColorStyle` converts the last data row into a footer and
 * overwrites its cells with SUM formulas.
 */
function bandingRequests(
  banding: NonNullable<StyleArgs["banding"]>,
  sheetId: number,
  baseRange: string | undefined,
  sheet: SheetSurface,
  compiled: CompiledTheme | undefined,
): BandingResult {
  const rangeA1 = banding.range ?? baseRange;
  const bounds = rangeA1 ? parseA1(rangeA1) : {};
  const existing = sheet.bandedRanges.find((b) => overlaps(bounds, b.bounds));
  const warnings: string[] = [];

  if (banding.remove) {
    if (!existing) {
      return {
        requests: [],
        description: "found no banding to remove",
        warnings: [`Nothing on ${rangeA1 ?? sheet.title} is banded, so there was nothing to remove.`],
      };
    }
    return {
      requests: [{ deleteBanding: { bandedRangeId: existing.bandedRangeId } }],
      description: `removed the banding on ${gridRangeToA1(existing.bounds)}`,
      warnings,
    };
  }

  if (compiled && !compiled.bandingApplies) {
    warnings.push(
      `The ${compiled.archetype} archetype turns banding off, because banding and a font-color language fight each other for the reader's attention. This call banded anyway, which was asked for explicitly.`,
    );
  }

  const first = banding.first
    ? parseColorStyle(banding.first)
    : (compiled?.banding.first ?? parseColorStyle("#FFFFFF"));
  const second = banding.second
    ? parseColorStyle(banding.second)
    : (compiled?.banding.second ?? parseColorStyle("#F2F5F8"));
  const rowProperties: Record<string, ColorStyle> = {
    firstBandColorStyle: first,
    secondBandColorStyle: second,
  };
  if (banding.header !== false && compiled?.banding.header) {
    rowProperties["headerColorStyle"] = compiled.banding.header;
  }

  if (existing) {
    return {
      requests: [
        {
          updateBanding: {
            bandedRange: {
              bandedRangeId: existing.bandedRangeId,
              range: { sheetId, ...bounds },
              rowProperties,
            },
            fields: `range,rowProperties(${Object.keys(rowProperties).join(",")})`,
          },
        },
      ],
      description: `updated the banding on ${rangeA1 ?? "the whole tab"}`,
      warnings,
    };
  }

  return {
    requests: [
      { addBanding: { bandedRange: { range: { sheetId, ...bounds }, rowProperties } } },
    ],
    description: `banded ${rangeA1 ?? "the whole tab"}`,
    warnings,
  };
}

/**
 * Clearing a tab properly means removing each thing separately.
 *
 * `updateCells` with a format mask does not clear banding, conditional format
 * rules, or merges: they are separate objects that survive it and reappear
 * over whatever is written next. Conditional rules are addressed by index and
 * shift as they are deleted, so they go from the end backwards.
 */
function clearRequests(
  clear: NonNullable<StyleArgs["clear"]>,
  sheetId: number,
  bounds: RangeBounds,
  sheet: SheetSurface,
): unknown[] {
  const requests: unknown[] = [];

  if (clear.banding) {
    for (const banded of sheet.bandedRanges) {
      if (overlaps(bounds, banded.bounds)) {
        requests.push({ deleteBanding: { bandedRangeId: banded.bandedRangeId } });
      }
    }
  }
  if (clear.conditional_formats) {
    for (let index = sheet.conditionalFormatCount - 1; index >= 0; index -= 1) {
      requests.push({ deleteConditionalFormatRule: { sheetId, index } });
    }
  }
  if (clear.merges) {
    requests.push({ unmergeCells: { range: { sheetId, ...bounds } } });
  }
  if (clear.formats !== false) {
    requests.push({
      repeatCell: {
        range: { sheetId, ...bounds },
        cell: { userEnteredFormat: {} },
        fields: "userEnteredFormat",
      },
    });
  }
  return requests;
}

function sheetPropertyRequest(
  args: StyleArgs,
  sheetId: number,
  compiled: CompiledTheme | undefined,
): { request: unknown; described: string[] } | undefined {
  const gridProperties: Record<string, unknown> = {};
  const properties: Record<string, unknown> = { sheetId };
  const described: string[] = [];

  if (args.freeze_rows !== undefined) {
    gridProperties["frozenRowCount"] = args.freeze_rows;
    described.push(
      args.freeze_rows === 0 ? "unfroze the header" : `froze ${count(args.freeze_rows, "row")}`,
    );
  }
  if (args.freeze_columns !== undefined) {
    gridProperties["frozenColumnCount"] = args.freeze_columns;
    described.push(`froze ${count(args.freeze_columns, "column")}`);
  }
  if (args.gridlines !== undefined) {
    gridProperties["hideGridlines"] = !args.gridlines;
    described.push(args.gridlines ? "showed the gridlines" : "hid the gridlines");
  }
  if (args.tab_color !== undefined) {
    properties["tabColorStyle"] =
      args.tab_color.trim().toLowerCase() === "none"
        ? { rgbColor: {} }
        : resolveTabColor(args.tab_color, compiled);
    described.push(`set the tab color`);
  }

  if (Object.keys(gridProperties).length) properties["gridProperties"] = gridProperties;
  if (Object.keys(properties).length <= 1) return undefined;

  const fields = buildFieldMask(pruneUndefined({ ...properties, sheetId: undefined }));
  return {
    request: { updateSheetProperties: { properties, fields } },
    described,
  };
}

/** A tab color may name a preset tab role as well as a color. */
function resolveTabColor(spec: string, compiled: CompiledTheme | undefined): ColorStyle {
  const key = spec.trim().toLowerCase();
  if (key === "inputs" || key === "workings" || key === "outputs") {
    const fromPreset = compiled?.tabColors[key];
    if (fromPreset) return fromPreset;
    throw err.invalid(
      `"${spec}" is a tab role, and this preset defines no color for it.`,
      "Pass a color, a theme slot like theme:ACCENT1, or none to clear the tab color.",
    );
  }
  return parseColorStyle(spec);
}

// ---------------------------------------------------------------------------
// Manifest metadata
// ---------------------------------------------------------------------------

/**
 * Record which preset this spreadsheet is styled with.
 *
 * Without it the next session has to infer the palette from the colors, which
 * is a guess. Written at PROJECT visibility, which survives a copy of the file
 * and rides the column rather than the index (spike 5).
 */
function manifestRequest(compiled: CompiledTheme, existing: MetadataEntry[]): unknown {
  const value = manifestValue(compiled);
  const hit = existing.find((e) => e.key === METADATA_KEYS.manifest && e.scope === "SPREADSHEET");

  if (hit) {
    return {
      updateDeveloperMetadata: {
        dataFilters: [
          {
            developerMetadataLookup: {
              metadataKey: METADATA_KEYS.manifest,
              metadataLocation: { spreadsheet: true },
              locationMatchingStrategy: "EXACT_LOCATION",
            },
          },
        ],
        developerMetadata: { metadataKey: METADATA_KEYS.manifest, metadataValue: value },
        fields: "metadataValue",
      },
    };
  }
  return {
    createDeveloperMetadata: {
      developerMetadata: {
        metadataKey: METADATA_KEYS.manifest,
        metadataValue: value,
        location: { spreadsheet: true },
        visibility: "PROJECT",
      },
    },
  };
}

/** The same, for one tab, so a workbook can hold a model tab beside trackers. */
function sheetMetadataRequest(
  compiled: CompiledTheme,
  sheetId: number,
  existing: MetadataEntry[],
): unknown {
  const value = JSON.stringify({ preset: compiled.preset.name, archetype: compiled.archetype });
  const hit = existing.find(
    (e) => e.key === METADATA_KEYS.sheet && e.scope === "SHEET" && e.sheetId === sheetId,
  );

  if (hit) {
    return {
      updateDeveloperMetadata: {
        dataFilters: [
          {
            developerMetadataLookup: {
              metadataKey: METADATA_KEYS.sheet,
              metadataLocation: { sheetId },
              locationMatchingStrategy: "EXACT_LOCATION",
            },
          },
        ],
        developerMetadata: { metadataKey: METADATA_KEYS.sheet, metadataValue: value },
        fields: "metadataValue",
      },
    };
  }
  return {
    createDeveloperMetadata: {
      developerMetadata: {
        metadataKey: METADATA_KEYS.sheet,
        metadataValue: value,
        location: { sheetId },
        visibility: "PROJECT",
      },
    },
  };
}

async function readMetadata(
  ctx: Awaited<ReturnType<ToolDeps["getContext"]>>,
  spreadsheetId: string,
): Promise<MetadataEntry[]> {
  try {
    const search = await withRetry(() =>
      ctx.sheets.spreadsheets.developerMetadata.search({
        spreadsheetId,
        requestBody: { dataFilters: [{ developerMetadataLookup: {} }] },
      }),
    );
    return toMetadataEntries(
      (search.data.matchedDeveloperMetadata ?? []).flatMap((m) =>
        m.developerMetadata ? [m.developerMetadata] : [],
      ),
    );
  } catch {
    return [];
  }
}

function safeBounds(range: string): RangeBounds | undefined {
  try {
    return parseA1(range);
  } catch {
    return undefined;
  }
}
