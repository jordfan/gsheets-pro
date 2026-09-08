/**
 * `sheets_read`: values, formulas, or both.
 *
 * Three choices shape this tool.
 *
 * Records by default. A grid of strings makes the model count columns, and it
 * miscounts. Records keyed by header do not, and every record carries `_row`,
 * the true one based row in the sheet, so a later write lands on the row it
 * meant even after someone sorts the tab.
 *
 * Formulas are first class. `=SUM(B2:B9)` displayed as `312` is a different
 * fact from the number 312, and a tool that only ever shows the number will
 * eventually overwrite a formula with its own stale result.
 *
 * Big reads paginate rather than truncate. A response that silently stops
 * halfway is how an agent concludes a roster has 40 students when it has 90.
 */

import { z } from "zod";

import { columnIndexToLetter, gridRangeToA1, parseA1, quoteSheetName, rangeCellCount } from "../lib/a1.js";
import { colorStyleToText } from "../lib/colors.js";
import { describeNumberFormat } from "../lib/numfmt.js";
import { err } from "../lib/errors.js";
import {
  applyWhere,
  findInGrid,
  normalizeHeaders,
  paginate,
  toRecords,
  WHERE_OPERATORS,
  type CellValue,
  type FindHit,
  type SheetRecord,
  type WhereClause,
} from "../lib/records.js";
import { count, guarded, lines, listOf, ok, type ToolResponse } from "../lib/result.js";
import { withRetry } from "../lib/batch.js";
import type { ToolDefinition, ToolDeps } from "./types.js";

/** Detail reads (format, note, validation) are capped, per the plan. */
export const DETAIL_CELL_CAP = 500;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;

const DETAIL_MASK = [
  "sheets.properties(sheetId,title)",
  "sheets.data(startRow,startColumn,rowData.values(",
  "note,",
  "userEnteredFormat(numberFormat,horizontalAlignment,wrapStrategy,textFormat(bold,italic,fontSize,fontFamily,foregroundColorStyle),backgroundColorStyle),",
  "dataValidation(condition(type,values(userEnteredValue)),strict)",
  "))",
].join("");

export const readInputSchema = {
  spreadsheet_id: z.string().describe("The spreadsheet id, the long id in the middle of the sheet's URL."),
  sheet: z
    .string()
    .optional()
    .describe("The tab name. Required unless find is used, which searches every tab."),
  range: z
    .string()
    .optional()
    .describe("A1 range within the tab, for example A1:F50 or C:C. Defaults to the whole tab."),
  as: z
    .enum(["records", "grid"])
    .optional()
    .describe(
      "records (default) keys each row by its header and stamps _row with the true sheet row. grid returns raw rows, which is what you want when there is no header.",
    ),
  values: z
    .enum(["formatted", "raw", "formulas", "both"])
    .optional()
    .describe(
      "formatted (default) is what a person sees. raw is the underlying value. formulas shows =FORMULAS. both returns the displayed value and the formula side by side.",
    ),
  header_row: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("One based row holding the headers. Inferred from the frozen rows or the first text row when omitted."),
  columns: z
    .array(z.string().min(1))
    .optional()
    .describe("Return only these columns, named by header or by column letter."),
  where: z
    .array(
      z.object({
        column: z.string().min(1).describe("Header name or column letter."),
        op: z.enum(WHERE_OPERATORS),
        value: z
          .union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))])
          .optional(),
      }),
    )
    .optional()
    .describe("Filter records. Every clause must match. Text comparisons ignore case."),
  find: z
    .object({
      query: z.string().min(1),
      match_case: z.boolean().optional(),
      whole_cell: z.boolean().optional(),
      regex: z.boolean().optional(),
      in_sheets: z.array(z.string().min(1)).optional().describe("Limit the search to these tabs."),
    })
    .optional()
    .describe("Search across tabs for text and return where it sits. Ignores range, columns and where."),
  include: z
    .object({
      formats: z.boolean().optional(),
      notes: z.boolean().optional(),
      validation: z.boolean().optional(),
    })
    .optional()
    .describe(`Also return cell formatting, notes, or validation. Capped at ${DETAIL_CELL_CAP} cells.`),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Rows per page. Default ${DEFAULT_LIMIT}.`),
  offset: z.number().int().min(0).optional().describe("Rows to skip, for paging through a long tab."),
};

type ReadArgs = {
  spreadsheet_id: string;
  sheet?: string;
  range?: string;
  as?: "records" | "grid";
  values?: "formatted" | "raw" | "formulas" | "both";
  header_row?: number;
  columns?: string[];
  where?: WhereClause[];
  find?: {
    query: string;
    match_case?: boolean;
    whole_cell?: boolean;
    regex?: boolean;
    in_sheets?: string[];
  };
  include?: { formats?: boolean; notes?: boolean; validation?: boolean };
  limit?: number;
  offset?: number;
};

const RENDER_OPTION = {
  formatted: "FORMATTED_VALUE",
  raw: "UNFORMATTED_VALUE",
  formulas: "FORMULA",
} as const;

export function createReadTool(deps: ToolDeps): ToolDefinition<typeof readInputSchema> {
  return {
    name: "sheets_read",
    config: {
      title: "Read a sheet",
      description:
        "Read values, formulas, or both. Returns records keyed by header with the true sheet row on each, or a raw grid. Filter with where, search every tab with find, and page with limit and offset. Optionally returns cell formatting, notes and validation.",
      inputSchema: readInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler: guarded(async (raw: Record<string, unknown>): Promise<ToolResponse> => {
      const args = raw as ReadArgs;
      const ctx = await deps.getContext();

      if (args.find) return runFind(ctx, args);
      if (!args.sheet) {
        throw err.invalid(
          "sheet is required.",
          "Pass the tab name, for example Tracker. To search every tab instead, pass find.",
        );
      }

      const info = await ctx.cache.resolve(args.spreadsheet_id, args.sheet);
      const rangeA1 = args.range?.trim() || undefined;
      const reference = `${quoteSheetName(info.title)}${rangeA1 ? `!${rangeA1}` : ""}`;
      if (rangeA1) parseA1(rangeA1); // Fail here, with our message, not the API's.

      const mode = args.values ?? "formatted";
      const primary = mode === "both" ? "formatted" : mode;

      const valueResponse = await withRetry(() =>
        ctx.sheets.spreadsheets.values.batchGet({
          spreadsheetId: args.spreadsheet_id,
          ranges: [reference],
          valueRenderOption: RENDER_OPTION[primary],
          dateTimeRenderOption: "FORMATTED_STRING",
          majorDimension: "ROWS",
        }),
      );
      const valueRange = valueResponse.data.valueRanges?.[0];
      const grid = (valueRange?.values ?? []) as CellValue[][];
      const returnedRange = valueRange?.range ?? reference;

      let formulaGrid: CellValue[][] | undefined;
      if (mode === "both") {
        const formulaResponse = await withRetry(() =>
          ctx.sheets.spreadsheets.values.batchGet({
            spreadsheetId: args.spreadsheet_id,
            ranges: [reference],
            valueRenderOption: "FORMULA",
            majorDimension: "ROWS",
          }),
        );
        formulaGrid = (formulaResponse.data.valueRanges?.[0]?.values ?? []) as CellValue[][];
      }

      // Where the block actually starts in the sheet, so _row is the true row.
      const bounds = rangeA1 ? parseA1(rangeA1) : {};
      const originRow = (bounds.startRowIndex ?? 0) + 1;
      const originColumn = bounds.startColumnIndex ?? 0;

      const asRecords = (args.as ?? "records") === "records";
      const headerOffset = resolveHeaderOffset(args.header_row, originRow, info.frozenRowCount, grid, asRecords);

      let headers: string[] = [];
      let firstDataRow = originRow;
      let dataRows = grid;
      if (asRecords && headerOffset !== undefined) {
        headers = normalizeHeaders(
          (grid[headerOffset] ?? []).map((c) => (c === null || c === undefined ? "" : String(c))),
          Math.max(...grid.map((r) => r.length), 0),
        );
        firstDataRow = originRow + headerOffset + 1;
        dataRows = grid.slice(headerOffset + 1);
      }

      let records: SheetRecord[] = [];
      let filtered = 0;
      if (asRecords && headers.length) {
        records = toRecords(dataRows, headers, { firstDataRow });
        if (formulaGrid) {
          const formulaRows = formulaGrid.slice(headerOffset === undefined ? 0 : headerOffset + 1);
          attachFormulas(records, formulaRows, headers, firstDataRow);
        }
        const before = records.length;
        records = applyWhere(records, args.where, headers);
        filtered = before - records.length;
        if (args.columns?.length) records = pickColumns(records, args.columns, headers);
      } else if (args.where?.length) {
        throw err.invalid(
          "where needs records, and this read produced none.",
          "Either the tab has no header row or as was set to grid. Pass header_row to say which row holds the headers.",
        );
      }

      const limit = args.limit ?? DEFAULT_LIMIT;
      const page = asRecords && headers.length ? paginate(records, args.offset ?? 0, limit) : undefined;
      const gridPage = page ? undefined : paginate(grid, args.offset ?? 0, limit);

      const detail = await readDetail(ctx, args, reference, originRow, originColumn);

      const structured: Record<string, unknown> = {
        spreadsheet_id: args.spreadsheet_id,
        sheet: info.title,
        range: returnedRange,
        mode,
        shape: page ? "records" : "grid",
        headers: headers.length ? headers : undefined,
        header_row: headerOffset !== undefined ? originRow + headerOffset : undefined,
        first_data_row: page ? firstDataRow : undefined,
        records: page?.items,
        rows: gridPage?.items,
        pagination: page
          ? { offset: page.offset, limit: page.limit, total: page.total, next_offset: page.nextOffset ?? null }
          : {
              offset: gridPage!.offset,
              limit: gridPage!.limit,
              total: gridPage!.total,
              next_offset: gridPage!.nextOffset ?? null,
            },
        filtered_out: filtered || undefined,
        detail: detail.payload,
        warnings: detail.warnings,
      };

      return ok(readProse(info.title, returnedRange, mode, page, gridPage, filtered, detail.warnings), structured, {
        maxResultSizeChars: 150_000,
      });
    }),
  };
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/**
 * Which row inside the returned block holds the headers, as an offset from the
 * top of the block. Frozen rows are the strongest signal a person leaves; the
 * first all text row is the fallback.
 */
export function resolveHeaderOffset(
  headerRow: number | undefined,
  originRow: number,
  frozenRowCount: number | undefined,
  grid: CellValue[][],
  asRecords: boolean,
): number | undefined {
  if (!asRecords) return undefined;
  if (headerRow !== undefined) {
    const offset = headerRow - originRow;
    if (offset < 0 || offset >= grid.length) {
      throw err.invalid(
        `Row ${headerRow} is not inside the range that was read.`,
        `The read starts at row ${originRow} and covers ${count(grid.length, "row")}. Widen the range, or pass a header_row inside it.`,
      );
    }
    return offset;
  }
  if (frozenRowCount && frozenRowCount >= originRow) {
    const offset = frozenRowCount - originRow;
    if (offset >= 0 && offset < grid.length) return offset;
  }
  for (let i = 0; i < Math.min(grid.length, 5); i += 1) {
    const row = grid[i] ?? [];
    const filled = row.filter((c) => String(c ?? "").trim() !== "");
    if (filled.length < 2) continue;
    if (filled.every((c) => typeof c !== "number" && !Number.isFinite(Number(String(c))))) return i;
  }
  return grid.length > 0 ? 0 : undefined;
}

function attachFormulas(
  records: SheetRecord[],
  formulaRows: CellValue[][],
  headers: string[],
  firstDataRow: number,
): void {
  for (const record of records) {
    const row = formulaRows[record._row - firstDataRow] ?? [];
    const formulas: Record<string, string> = {};
    headers.forEach((header, index) => {
      const value = row[index];
      if (typeof value === "string" && value.startsWith("=")) formulas[header] = value;
    });
    if (Object.keys(formulas).length) (record as Record<string, unknown>)["_formulas"] = formulas;
  }
}

function pickColumns(records: SheetRecord[], wanted: string[], headers: string[]): SheetRecord[] {
  const keys = wanted.map((name) => {
    const lower = name.trim().toLowerCase();
    const byHeader = headers.find((h) => h.toLowerCase() === lower);
    if (byHeader) return byHeader;
    if (/^[A-Za-z]{1,3}$/.test(name.trim())) {
      const index = headers.findIndex((_, i) => columnIndexToLetter(i).toLowerCase() === lower);
      if (index >= 0) return headers[index];
    }
    throw err.invalid(
      `No column named "${name}".`,
      headers.length ? `The columns are: ${headers.join(", ")}.` : "This tab has no header row.",
    );
  });
  return records.map((record) => {
    const out: SheetRecord = { _row: record._row };
    for (const key of keys) out[key] = record[key] as CellValue;
    if ("_formulas" in record) (out as Record<string, unknown>)["_formulas"] = record["_formulas"];
    return out;
  });
}

interface DetailResult {
  payload?: Record<string, unknown>;
  warnings: string[];
}

async function readDetail(
  ctx: Awaited<ReturnType<ToolDeps["getContext"]>>,
  args: ReadArgs,
  reference: string,
  originRow: number,
  originColumn: number,
): Promise<DetailResult> {
  const include = args.include;
  if (!include || (!include.formats && !include.notes && !include.validation)) return { warnings: [] };

  const bounds = args.range ? parseA1(args.range) : undefined;
  const cells = bounds ? rangeCellCount(bounds) : undefined;
  if (cells === undefined) {
    return {
      warnings: [
        `Formatting, notes and validation were not read: the range is open ended, and the detail read is capped at ${DETAIL_CELL_CAP} cells. Pass a bounded range like A1:F50.`,
      ],
    };
  }
  if (cells > DETAIL_CELL_CAP) {
    return {
      warnings: [
        `Formatting, notes and validation were not read: ${cells} cells is over the ${DETAIL_CELL_CAP} cell cap. Read a smaller range.`,
      ],
    };
  }

  const response = await withRetry(() =>
    ctx.sheets.spreadsheets.get({
      spreadsheetId: args.spreadsheet_id,
      ranges: [reference],
      includeGridData: true,
      fields: DETAIL_MASK,
    }),
  );
  const data = response.data.sheets?.[0]?.data?.[0];
  const rowData = data?.rowData ?? [];
  const startRow = (data?.startRow ?? originRow - 1) + 1;
  const startColumn = data?.startColumn ?? originColumn;

  const formats: Record<string, unknown> = {};
  const notes: Record<string, string> = {};
  const validation: Record<string, unknown> = {};

  rowData.forEach((row, r) => {
    (row.values ?? []).forEach((cell, c) => {
      const a1 = `${columnIndexToLetter(startColumn + c)}${startRow + r}`;
      if (include.notes && cell.note) notes[a1] = cell.note;
      if (include.formats && cell.userEnteredFormat) {
        const f = cell.userEnteredFormat;
        const entry: Record<string, unknown> = {};
        const numberFormat = describeNumberFormat(f.numberFormat);
        if (numberFormat) entry["number_format"] = numberFormat;
        if (f.horizontalAlignment) entry["align"] = f.horizontalAlignment;
        if (f.wrapStrategy) entry["wrap"] = f.wrapStrategy;
        if (f.textFormat?.bold) entry["bold"] = true;
        if (f.textFormat?.italic) entry["italic"] = true;
        if (f.textFormat?.fontSize) entry["font_size"] = f.textFormat.fontSize;
        if (f.textFormat?.fontFamily) entry["font"] = f.textFormat.fontFamily;
        const fg = colorStyleToText(f.textFormat?.foregroundColorStyle);
        if (fg) entry["text_color"] = fg;
        const bg = colorStyleToText(f.backgroundColorStyle);
        if (bg) entry["background"] = bg;
        if (Object.keys(entry).length) formats[a1] = entry;
      }
      if (include.validation && cell.dataValidation) {
        validation[a1] = {
          type: cell.dataValidation.condition?.type ?? null,
          values: (cell.dataValidation.condition?.values ?? [])
            .map((v) => v.userEnteredValue)
            .filter((v): v is string => typeof v === "string"),
          strict: cell.dataValidation.strict === true,
          ui_owned: true,
          note: "Chip colours cannot be read through the API. Treat this rule as the human's unless the plugin created it.",
        };
      }
    });
  });

  const payload: Record<string, unknown> = {};
  if (include.formats) payload["formats"] = formats;
  if (include.notes) payload["notes"] = notes;
  if (include.validation) payload["validation"] = validation;
  return { payload, warnings: [] };
}

async function runFind(
  ctx: Awaited<ReturnType<ToolDeps["getContext"]>>,
  args: ReadArgs,
): Promise<ToolResponse> {
  const find = args.find!;
  const all = await ctx.cache.list(args.spreadsheet_id);
  const wanted = find.in_sheets?.length
    ? find.in_sheets.map((name) => {
        const hit = all.byName.get(name.trim().toLowerCase());
        if (!hit) throw err.sheetNotFound(name, all.titles);
        return hit;
      })
    : [...all.byName.values()].filter((s) => s.sheetType === "GRID" && !s.hidden);

  if (wanted.length === 0) {
    throw err.invalid("This spreadsheet has no visible grid tabs to search.");
  }

  const limit = args.limit ?? DEFAULT_LIMIT;
  const response = await withRetry(() =>
    ctx.sheets.spreadsheets.values.batchGet({
      spreadsheetId: args.spreadsheet_id,
      ranges: wanted.map((s) => quoteSheetName(s.title)),
      valueRenderOption: "FORMATTED_VALUE",
      majorDimension: "ROWS",
    }),
  );

  const hits: FindHit[] = [];
  (response.data.valueRanges ?? []).forEach((vr, index) => {
    if (hits.length >= limit) return;
    const sheet = wanted[index];
    if (!sheet) return;
    const rows = (vr.values ?? []) as CellValue[][];
    const headers = normalizeHeaders(
      (rows[0] ?? []).map((c) => (c === null || c === undefined ? "" : String(c))),
    );
    hits.push(
      ...findInGrid(
        sheet.title,
        rows,
        {
          query: find.query,
          matchCase: find.match_case === true,
          wholeCell: find.whole_cell === true,
          regex: find.regex === true,
          limit: limit - hits.length,
        },
        headers,
      ),
    );
  });

  const page = paginate(hits, args.offset ?? 0, limit);
  const structured: Record<string, unknown> = {
    spreadsheet_id: args.spreadsheet_id,
    query: find.query,
    searched: wanted.map((s) => s.title),
    hits: page.items,
    pagination: {
      offset: page.offset,
      limit: page.limit,
      total: page.total,
      next_offset: page.nextOffset ?? null,
    },
  };

  const text = page.items.length
    ? lines(
        `Found "${find.query}" in ${count(page.total, "cell")} across ${listOf(wanted.map((s) => s.title))}.`,
        ...page.items.map(
          (hit) => `  ${hit.sheet}!${hit.cell}${hit.header ? ` (${hit.header})` : ""}: ${hit.value}`,
        ),
        page.nextOffset ? `\nMore results. Read again with offset ${page.nextOffset}.` : "",
      )
    : `No cell contains "${find.query}" on ${listOf(wanted.map((s) => s.title))}.`;

  return ok(text, structured, { maxResultSizeChars: 120_000 });
}

function readProse(
  sheet: string,
  range: string,
  mode: string,
  page: ReturnType<typeof paginate<SheetRecord>> | undefined,
  gridPage: ReturnType<typeof paginate<CellValue[]>> | undefined,
  filtered: number,
  warnings: string[],
): string {
  const head = page
    ? `${sheet} ${gridRangeToA1({})} read as ${count(page.total, "record")}${
        filtered ? `, ${filtered} filtered out` : ""
      }, showing ${page.items.length} from offset ${page.offset}.`
    : `${sheet}: ${count(gridPage?.total ?? 0, "row")}, showing ${gridPage?.items.length ?? 0} from offset ${gridPage?.offset ?? 0}.`;

  const rangeLine = `Range ${range}, values as ${mode}.`;
  const more = (page?.nextOffset ?? gridPage?.nextOffset)
    ? `More rows. Read again with offset ${page?.nextOffset ?? gridPage?.nextOffset}.`
    : undefined;
  const warn = warnings.length ? `\nWorth knowing:\n${warnings.map((w) => `- ${w}`).join("\n")}` : undefined;
  return lines(head.replace(" the whole sheet ", " "), rangeLine, more, warn);
}
