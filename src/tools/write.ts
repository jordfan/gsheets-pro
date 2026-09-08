/**
 * `sheets_write`: the only tool that changes a cell's value.
 *
 * Five modes, one set of guards. The modes exist because "write these values"
 * means five different things to a person, and collapsing them into one
 * `range` write is what produces the classic failures: an append that lands
 * below a second block of data, an update that renumbers rows, a fill that
 * copies a formula without adjusting its references.
 *
 * The guards are the point of the tool.
 *
 * A **formula guard** pre-reads the target with FORMULA render and refuses to
 * replace a cell that currently holds a formula. Overwriting somebody's
 * `=XLOOKUP(...)` with the number it happened to produce is silent and
 * permanent, and it is the single commonest way an agent ruins a spreadsheet.
 *
 * A **contract check** refuses a column the registry or the sheet's own
 * developer metadata marks as somebody else's. Hadeer's date columns are not
 * ours to fill in, whatever the email said.
 *
 * A **colleague-safe text check** refuses message ids, task markers, and
 * self-references on any sheet a person owns or shares. Somebody opens that
 * sheet with no idea an agent touched it.
 *
 * An **error gate** reads the written range back and reports whether it still
 * evaluates. `check: false` turns it off for the interior writes of a build,
 * where only the last one needs to answer.
 *
 * `force` overrides the first three. It never overrides the gate, because the
 * gate reports rather than refuses.
 *
 * Two API facts shape the append paths, both from spike 3. `appendCells` with
 * a `tableId` returns success, grows the Table by a row, and writes an EMPTY
 * one: the values are silently discarded. And `values.append` with
 * `INSERT_ROWS` appends past everything on the tab, so on a tab holding two
 * blocks of data it lands in the wrong place.
 *
 * So a Table append uses `values.append` over the Table's own range, which is
 * the only path that both writes the values and extends the Table. A non-Table
 * append finds the end of the first block itself and writes there through
 * `values.batchUpdate`, the plain update endpoint in its batched form: it
 * inserts no rows, so nothing below it moves, and it can carry the tail block
 * alongside an upsert's matched rows in a single call. A tab holding two
 * blocks has no single end to append to and is refused rather than guessed at.
 */

import { z } from "zod";

import {
  columnIndexToLetter,
  columnLetterToIndex,
  gridRangeToA1,
  parseA1,
  quoteSheetName,
  toA1Reference,
  type NullableBounds,
  type RangeBounds,
} from "../lib/a1.js";
import { withRetry } from "../lib/batch.js";
import {
  buildContract,
  readColumnMetadata,
  readManifest,
  readSheetMetadata,
  toMetadataEntries,
  type MetadataEntry,
  type SheetContract,
} from "../lib/contract.js";
import { err, GsheetsError } from "../lib/errors.js";
import {
  describeCheck,
  runErrorGate,
  withinGateCap,
  type GateCheck,
} from "../lib/errorgate.js";
import { normalizeHeaders, type CellValue } from "../lib/records.js";
import { assertWritable, describeSheet, isColumnWritable, type Policy } from "../lib/registry.js";
import { count, guarded, lines, listOf, ok, type ToolResponse } from "../lib/result.js";
import {
  checkTexts,
  colleagueSafeApplies,
  describeFindings,
  type SafeTextFinding,
} from "../lib/safetext.js";
import { resolveSpreadsheetId, SPREADSHEET_ID_DESCRIPTION } from "../lib/spreadsheetid.js";
import { recordWrite } from "../lib/writelog.js";
import type { ToolDefinition, ToolDeps } from "./types.js";

/** How far down a tab the append and upsert paths look for the data's end. */
const SCAN_ROWS = 5000;
/** Enough to find a header row when the mode needs nothing more. */
const HEADER_SCAN_ROWS = 25;
/** Cells named individually in a refusal before the rest are counted. */
const NAME_LIMIT = 8;

const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const writeInputSchema = {
  spreadsheet_id: z.string().describe(SPREADSHEET_ID_DESCRIPTION),
  sheet: z.string().describe("The tab name, as it reads on the tab strip."),
  mode: z
    .enum(["range", "append", "upsert", "fill", "log"])
    .optional()
    .describe(
      "range (default) writes a block at an A1 range. append adds rows at the end of the data. upsert matches on a key column and updates the rows it finds, appending the rest. fill writes one formula and autofills it down, adjusting its references. log appends a row and stamps it with today's date.",
    ),
  range: z
    .string()
    .optional()
    .describe("A1 range within the tab. Required for mode range and mode fill."),
  values: z
    .array(z.array(cellValue))
    .optional()
    .describe("Rows of cells, left to right, top to bottom."),
  records: z
    .array(z.record(z.string(), cellValue))
    .optional()
    .describe("Rows keyed by header name, in any column order. The header row decides where each lands."),
  rows: z
    .array(
      z.object({
        key: z.union([z.string(), z.number(), z.boolean()]).describe("The value to match in the key column."),
        set: z.record(z.string(), cellValue).describe("Fields to set, keyed by header name or column letter."),
      }),
    )
    .optional()
    .describe(
      "The batch form of upsert. Every key is resolved from one read, every change goes in one write, and the guards run once for the whole batch. Prefer this over one call per row.",
    ),
  key_column: z
    .string()
    .optional()
    .describe("Header name or column letter to match rows on, for upsert. Taken from the contract when omitted."),
  header_row: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("One based row holding the headers. Taken from the frozen rows, or inferred, when omitted."),
  at_row: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Write the appended rows starting at this row instead of where the data appears to end."),
  formula: z
    .string()
    .optional()
    .describe("For mode fill: the formula to write in the first row of the range before filling down."),
  timestamp_column: z
    .string()
    .optional()
    .describe("For mode log: which column gets the date. Found from the headers when omitted."),
  note: z
    .string()
    .optional()
    .describe("A cell note left on the written range, saying where the numbers came from."),
  raw: z
    .boolean()
    .optional()
    .describe(
      "Write every value literally, so a leading = stays text and a date-shaped string stays a string. Columns a Table or the contract types as TEXT are written this way regardless.",
    ),
  force: z
    .boolean()
    .optional()
    .describe(
      "Override the formula guard, the writable-column contract, and the colleague-safe text check. Read what the refusal named before passing this.",
    ),
  expect_contract: z
    .object({
      source: z.enum(["registry", "metadata", "registry+metadata", "none"]).optional(),
      owner: z.enum(["human", "shared", "agent"]).optional(),
      headers: z.array(z.string()).optional().describe("The header row, in order, as you believe it reads."),
      key_column: z.string().optional(),
      positional_rows: z.boolean().optional(),
    })
    .optional()
    .describe(
      "What you believe about this sheet. The write is refused if the sheet disagrees, which is how a plan made three calls ago stops being acted on after somebody edited the tab.",
    ),
  dry_run: z
    .boolean()
    .optional()
    .describe("Run every read and every guard, report exactly what would be written, and write nothing."),
  check: z
    .boolean()
    .optional()
    .describe(
      "Read the written range back and report whether it still evaluates. Default true. Set false for the interior writes of a build and let the last one answer.",
    ),
};

type WriteArgs = {
  spreadsheet_id: string;
  sheet: string;
  mode?: "range" | "append" | "upsert" | "fill" | "log";
  range?: string;
  values?: CellValue[][];
  records?: Array<Record<string, CellValue>>;
  rows?: Array<{ key: string | number | boolean; set: Record<string, CellValue> }>;
  key_column?: string;
  header_row?: number;
  at_row?: number;
  formula?: string;
  timestamp_column?: string;
  note?: string;
  raw?: boolean;
  force?: boolean;
  expect_contract?: {
    source?: string;
    owner?: string;
    headers?: string[];
    key_column?: string;
    positional_rows?: boolean;
  };
  dry_run?: boolean;
  check?: boolean;
};

type ValueInput = "RAW" | "USER_ENTERED";

/** One block of values bound for one A1 range. */
interface PlannedRange {
  /** Fully qualified, so it reads the same in the response as it did on the wire. */
  range: string;
  bounds: RangeBounds;
  values: CellValue[][];
  valueInputOption: ValueInput;
}

interface AppendPlan {
  /** Values.append over a Table's range, which is the only path that keeps both. */
  tableRange: string;
  values: CellValue[][];
  valueInputOption: ValueInput;
  /** Columns needing a RAW correction pass once the rows land. */
  rawColumns: number[];
}

interface FillPlan {
  sourceBounds: RangeBounds;
  fillLength: number;
  sheetId: number;
}

interface WritePlan {
  mode: string;
  ranges: PlannedRange[];
  append?: AppendPlan;
  fill?: FillPlan;
  /** Rows matched by an upsert, and rows that became appends. */
  matched: number;
  inserted: number;
  /** Human readable description of where the rows went. */
  placement: string;
}

export function createWriteTool(deps: ToolDeps): ToolDefinition<typeof writeInputSchema> {
  return {
    name: "sheets_write",
    config: {
      title: "Write values",
      description:
        "Write, append, upsert, fill, or log values. Refuses to overwrite a cell that currently holds a formula, refuses columns the registry or the sheet's metadata marks as somebody else's, and refuses text that would not read as a colleague's on a shared sheet. Every write reads its own range back and reports whether the sheet still evaluates.",
      inputSchema: writeInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handler: guarded(async (raw: Record<string, unknown>): Promise<ToolResponse> => {
      const args = raw as WriteArgs;
      const ctx = await deps.getContext();
      const spreadsheetId = resolveSpreadsheetId(args.spreadsheet_id);
      const mode = args.mode ?? "range";

      const info = await ctx.cache.resolve(spreadsheetId, args.sheet);
      const sheetName = info.title;

      // Everything the guards need, in as few reads as the API allows.
      const surface = await readSurface(ctx, spreadsheetId, info, args, mode);
      const { headers, headerRow, contract, policy } = surface;

      assertWritable(policy, { tool: "sheets_write", ...(args.force ? { force: true } : {}) });
      assertExpectedContract(args.expect_contract, contract, headers, sheetName);

      const plan = await buildPlan({ ctx, spreadsheetId, info, args, mode, surface });

      const warnings: string[] = [...surface.warnings];
      const touched = touchedColumns(plan);

      // Guard 1: columns that are not ours.
      const refusedColumns = touched
        .map((index) => columnRefusal(index, headers, contract, policy))
        .filter((r): r is string => !!r);
      if (refusedColumns.length && !args.force) {
        throw new GsheetsError(
          "contract_violation",
          `This write touches ${count(refusedColumns.length, "column")} that ${refusedColumns.length === 1 ? "is" : "are"} not ours on ${sheetName}. ${refusedColumns.join(" ")}`,
          "Write only the columns the contract marks as ours. If this genuinely is our column and the registry is out of date, fix the registry rather than passing force.",
          { columns: refusedColumns },
        );
      }
      if (refusedColumns.length) {
        warnings.push(
          `force was passed, so ${count(refusedColumns.length, "column")} outside the contract ${refusedColumns.length === 1 ? "was" : "were"} written: ${refusedColumns.join(" ")}`,
        );
      }

      // Guard 2: formulas already in the cells we are about to replace.
      const formulaHits = await findFormulaCollisions(ctx, spreadsheetId, sheetName, plan);
      if (formulaHits.length && !args.force) {
        const named = formulaHits.slice(0, NAME_LIMIT).map((h) => `${h.cell} holds ${h.formula}`);
        throw new GsheetsError(
          "formula_guard",
          `${count(formulaHits.length, "cell")} in the target range currently ${formulaHits.length === 1 ? "holds a formula" : "hold formulas"}: ${named.join("; ")}${formulaHits.length > NAME_LIMIT ? `; and ${formulaHits.length - NAME_LIMIT} more` : ""}.`,
          "Replacing a formula with the value it happened to produce is silent and permanent. Read those cells, decide whether you meant to, and pass force if you did. To change what a formula computes, write the new formula rather than its result.",
          { cells: formulaHits.slice(0, NAME_LIMIT * 4) },
        );
      }
      if (formulaHits.length) {
        warnings.push(
          `force was passed, so ${count(formulaHits.length, "formula")} ${formulaHits.length === 1 ? "was" : "were"} replaced: ${formulaHits.slice(0, NAME_LIMIT).map((h) => h.cell).join(", ")}.`,
        );
      }

      // Guard 3: text that would not read as a colleague's.
      const safeText = runSafeTextCheck(plan, sheetName, policy);
      const refusals = safeText.filter((f) => f.severity === "refuse");
      if (refusals.length && !args.force) {
        throw new GsheetsError(
          "contract_violation",
          `${count(refusals.length, "value")} would not read as a colleague's on ${sheetName}, which is ${policy?.owner === "human" ? "somebody else's spreadsheet" : "shared"}. ${describeFindings(refusals)}`,
          "Somebody opens this sheet with no idea an agent touched it. Rewrite the text as a sentence a colleague would have typed. If this vocabulary is legitimate here, add it to the sheet's allowlist in .claude/gsheets-pro.json rather than passing force.",
          { findings: refusals.slice(0, 20) },
        );
      }
      for (const finding of safeText.filter((f) => f.severity === "warn" || args.force)) {
        warnings.push(`${finding.location}: "${finding.matched}" (${finding.rule}). ${finding.fix}`);
      }

      if (args.dry_run) {
        return dryRunResponse(spreadsheetId, sheetName, plan, warnings, headerRow);
      }

      // ---- the writes themselves ----
      const written = await execute(ctx, spreadsheetId, sheetName, plan, args);
      ctx.cache.invalidate(spreadsheetId);

      // Every range this session wrote, whether or not the gate reads it back.
      // Lint rule L14 asks what WE put in a human's column, and a value sitting
      // there is no evidence either way: the human probably typed it.
      for (const range of written.ranges) {
        recordWrite({ spreadsheetId, range, sheet: sheetName, tool: "sheets_write" });
      }

      const gateRanges = written.ranges.filter((r) => {
        const bounds = safeParse(r);
        return bounds ? withinGateCap(bounds) : false;
      });
      const check: GateCheck =
        args.check === false
          ? await runErrorGate(ctx.sheets as never, spreadsheetId, [], {
              skip: "check was false, so this write did not read itself back. Run sheets_check, or the last write of the build, before calling the work done.",
            })
          : await runErrorGate(ctx.sheets as never, spreadsheetId, gateRanges);

      const structured: Record<string, unknown> = {
        spreadsheet_id: spreadsheetId,
        sheet: sheetName,
        mode: plan.mode,
        ranges: written.ranges,
        updated_cells: written.updatedCells,
        updated_rows: written.updatedRows,
        matched: plan.matched,
        inserted: plan.inserted,
        placement: plan.placement,
        api_calls: written.calls,
        contract: { source: contract.source, summary: contract.summary },
        check,
        warnings,
      };

      return ok(
        lines(
          `${describePlan(plan, sheetName, written)}`,
          plan.placement,
          describeCheck(check),
          warnings.length ? `\nWorth knowing:\n${warnings.map((w) => `- ${w}`).join("\n")}` : undefined,
        ),
        structured,
      );
    }),
  };
}

// ---------------------------------------------------------------------------
// Reading what the guards need
// ---------------------------------------------------------------------------

interface TableInfo {
  tableId: string;
  name?: string;
  bounds: NullableBounds;
  columnTypes: Map<number, string>;
}

interface Surface {
  headers: string[];
  /** One based row the headers sit on, or undefined when the tab has none. */
  headerRow?: number;
  /** One based row the data starts on. */
  firstDataRow: number;
  /** One based row of the last filled row of the first block of data. */
  lastDataRow: number;
  multipleBlocks: boolean;
  grid: CellValue[][];
  contract: SheetContract;
  policy?: Policy;
  tables: TableInfo[];
  warnings: string[];
}

const TABLE_MASK =
  "sheets.properties(sheetId,title),sheets.tables(tableId,name,range,columnProperties(columnIndex,columnName,columnType))";

async function readSurface(
  ctx: Awaited<ReturnType<ToolDeps["getContext"]>>,
  spreadsheetId: string,
  info: { sheetId: number; title: string; frozenRowCount?: number },
  args: WriteArgs,
  mode: string,
): Promise<Surface> {
  const warnings: string[] = [];
  const reference = quoteSheetName(info.title);

  // Native Tables decide how an append has to be done, so they are read even
  // on a plain range write: a Table is the thing most likely to be underneath.
  let tables: TableInfo[] = [];
  try {
    const response = await withRetry(() =>
      ctx.sheets.spreadsheets.get({ spreadsheetId, fields: TABLE_MASK }),
    );
    for (const sheet of response.data.sheets ?? []) {
      if (sheet.properties?.sheetId !== info.sheetId) continue;
      tables = (sheet.tables ?? []).map((t) => ({
        tableId: t.tableId ?? "",
        ...(t.name ? { name: t.name } : {}),
        bounds: (t.range ?? {}) as NullableBounds,
        columnTypes: new Map(
          (t.columnProperties ?? []).flatMap((c) =>
            c.columnIndex !== undefined && c.columnIndex !== null && c.columnType
              ? [[c.columnIndex, c.columnType] as [number, string]]
              : [],
          ),
        ),
      }));
    }
  } catch (error) {
    warnings.push(
      `The tab's native Tables could not be read (${(error as Error).message}), so this write treated the tab as a plain range.`,
    );
  }

  // One values read, rendered as formulas. Headers are text and read the same
  // either way, so this one call feeds the header inference and the formula
  // guard both.
  //
  // How far down depends on what the mode needs to know. A range or a fill
  // write needs only the header row; an append or an upsert has to know where
  // the data ends and whether a second block sits below it, which means
  // reading the tab. On a long roster that is the difference between a few
  // rows and several thousand.
  const scanRows = mode === "append" || mode === "log" || mode === "upsert" ? SCAN_ROWS : HEADER_SCAN_ROWS;
  const scan = `${reference}!A1:${columnIndexToLetter(51)}${scanRows}`;
  const response = await withRetry(() =>
    ctx.sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: [scan],
      valueRenderOption: "FORMULA",
      majorDimension: "ROWS",
    }),
  );
  const grid = (response.data.valueRanges?.[0]?.values ?? []) as CellValue[][];

  const headerRow = resolveHeaderRow(args.header_row, info.frozenRowCount, grid);
  const headers =
    headerRow !== undefined
      ? normalizeHeaders(
          (grid[headerRow - 1] ?? []).map((c) => (c === null || c === undefined ? "" : String(c))),
        )
      : [];

  const firstDataRow = headerRow !== undefined ? headerRow + 1 : 1;
  const blocks = findBlocks(grid, firstDataRow);

  let metadataEntries: MetadataEntry[] = [];
  try {
    const search = await withRetry(() =>
      ctx.sheets.spreadsheets.developerMetadata.search({
        spreadsheetId,
        requestBody: { dataFilters: [{ developerMetadataLookup: {} }] },
      }),
    );
    metadataEntries = toMetadataEntries(
      (search.data.matchedDeveloperMetadata ?? []).flatMap((m) =>
        m.developerMetadata ? [m.developerMetadata] : [],
      ),
    );
  } catch {
    // A sheet a person built carries no metadata at all, which is the common
    // case and not worth a warning on every write.
  }

  const policy = ctx.registry?.policyFor(spreadsheetId, info.title);
  const contract = buildContract({
    sheet: info.title,
    headers,
    ...(policy ? { policy } : {}),
    columnMetadata: readColumnMetadata(metadataEntries, info.sheetId),
    ...(readSheetMetadata(metadataEntries, info.sheetId)
      ? { sheetMetadata: readSheetMetadata(metadataEntries, info.sheetId)! }
      : {}),
    ...(readManifest(metadataEntries) ? { manifest: readManifest(metadataEntries)! } : {}),
  });

  if (blocks.multipleBlocks && (mode === "append" || mode === "log")) {
    warnings.push(
      `A blank row splits this tab into more than one block of data. The append targets the end of the first block, row ${blocks.lastDataRow}, not the bottom of the tab.`,
    );
  }

  const surface: Surface = {
    headers,
    firstDataRow,
    lastDataRow: blocks.lastDataRow,
    multipleBlocks: blocks.multipleBlocks,
    grid,
    contract,
    tables,
    warnings,
  };
  if (headerRow !== undefined) surface.headerRow = headerRow;
  if (policy) surface.policy = policy;
  return surface;
}

/** One based header row: what was asked for, then frozen rows, then the first text row. */
export function resolveHeaderRow(
  headerRow: number | undefined,
  frozenRowCount: number | undefined,
  grid: CellValue[][],
): number | undefined {
  if (headerRow !== undefined) return headerRow;
  if (frozenRowCount && frozenRowCount > 0) return frozenRowCount;
  for (let i = 0; i < Math.min(grid.length, 10); i += 1) {
    const row = grid[i] ?? [];
    const filled = row.filter((c) => String(c ?? "").trim() !== "");
    if (filled.length < 2) continue;
    if (filled.every((c) => typeof c !== "number" && !Number.isFinite(Number(String(c))))) return i + 1;
  }
  return grid.length > 0 ? 1 : undefined;
}

/**
 * Where the first block of data ends, and whether there is a second one.
 *
 * A tab holding a roster and then, four rows below it, a small summary table
 * is the case that breaks a naive append. The end of the data is the end of
 * the FIRST block, not the last filled row on the tab.
 */
export function findBlocks(
  grid: CellValue[][],
  firstDataRow: number,
): { lastDataRow: number; multipleBlocks: boolean } {
  const filled = (i: number) => (grid[i] ?? []).some((c) => String(c ?? "").trim() !== "");
  let last = firstDataRow - 1;
  let i = firstDataRow - 1;
  for (; i < grid.length; i += 1) {
    if (!filled(i)) break;
    last = i + 1;
  }
  let multipleBlocks = false;
  for (let j = i; j < grid.length; j += 1) {
    if (filled(j)) {
      multipleBlocks = true;
      break;
    }
  }
  return { lastDataRow: last, multipleBlocks };
}

// ---------------------------------------------------------------------------
// expect_contract
// ---------------------------------------------------------------------------

function assertExpectedContract(
  expected: WriteArgs["expect_contract"],
  contract: SheetContract,
  headers: string[],
  sheetName: string,
): void {
  if (!expected) return;
  const mismatches: string[] = [];

  if (expected.source && expected.source !== contract.source) {
    mismatches.push(`the contract comes from ${contract.source}, not ${expected.source}`);
  }
  if (expected.owner && expected.owner !== (contract.owner ?? "agent")) {
    mismatches.push(`the owner is ${contract.owner ?? "unstated"}, not ${expected.owner}`);
  }
  if (expected.positional_rows !== undefined && expected.positional_rows !== contract.positionalRows) {
    mismatches.push(
      contract.positionalRows
        ? "rows on this sheet are positional"
        : "rows on this sheet are not marked positional",
    );
  }
  if (expected.headers) {
    const actual = headers.map((h) => h.trim().toLowerCase());
    const wanted = expected.headers.map((h) => h.trim().toLowerCase());
    const differs =
      wanted.length !== actual.length || wanted.some((h, i) => h !== actual[i]);
    if (differs) {
      mismatches.push(`the header row now reads ${headers.join(" | ") || "(empty)"}`);
    }
  }
  if (expected.key_column) {
    const wanted = expected.key_column.trim().toLowerCase();
    const actual = (contract.keyColumn ?? "").trim().toLowerCase();
    if (actual && actual !== wanted) {
      mismatches.push(`the key column is ${contract.keyColumn}, not ${expected.key_column}`);
    }
  }

  if (mismatches.length) {
    throw new GsheetsError(
      "contract_violation",
      `${sheetName} is not what this write expected: ${listOf(mismatches)}.`,
      "Somebody changed the tab since the plan was made. Call sheets_open again, look at what changed, and decide whether the write still means what it meant.",
      { mismatches },
    );
  }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

interface PlanInput {
  ctx: Awaited<ReturnType<ToolDeps["getContext"]>>;
  spreadsheetId: string;
  info: { sheetId: number; title: string };
  args: WriteArgs;
  mode: string;
  surface: Surface;
}

async function buildPlan(input: PlanInput): Promise<WritePlan> {
  switch (input.mode) {
    case "range":
      return planRange(input);
    case "append":
    case "log":
      return planAppend(input, input.mode === "log");
    case "upsert":
      return planUpsert(input);
    case "fill":
      return planFill(input);
    default:
      throw err.invalid(`Unknown mode "${input.mode}".`, "Use range, append, upsert, fill, or log.");
  }
}

/** Which valueInputOption a column wants, and whether anything forces RAW. */
function valueInputFor(
  columnIndex: number,
  args: WriteArgs,
  surface: Surface,
): ValueInput {
  if (args.raw === true) return "RAW";
  for (const table of surface.tables) {
    if (!containsColumn(table.bounds, columnIndex)) continue;
    const start = table.bounds.startColumnIndex ?? 0;
    if (table.columnTypes.get(columnIndex - start) === "TEXT") return "RAW";
    if (table.columnTypes.get(columnIndex) === "TEXT") return "RAW";
  }
  const column = surface.contract.columns[columnIndex];
  if (column?.type && column.type.toUpperCase() === "TEXT") return "RAW";
  return "USER_ENTERED";
}

function containsColumn(bounds: NullableBounds, columnIndex: number): boolean {
  const start = bounds.startColumnIndex ?? 0;
  const end = bounds.endColumnIndex ?? Number.MAX_SAFE_INTEGER;
  return columnIndex >= start && columnIndex < end;
}

function planRange(input: PlanInput): WritePlan {
  const { args, surface, info } = input;
  const rangeA1 = args.range?.trim();
  if (!rangeA1) {
    throw err.invalid(
      "range is required for mode range.",
      "Pass an A1 range like B2:E20. To add rows at the end of the data instead, use mode append.",
    );
  }
  const bounds = parseA1(rangeA1);
  const values = gridFromArgs(args, surface.headers, bounds.startColumnIndex ?? 0);
  if (values.length === 0) {
    throw err.invalid("Nothing to write: values and records were both empty.");
  }

  const startColumn = bounds.startColumnIndex ?? 0;
  const startRow = bounds.startRowIndex ?? 0;
  const width = Math.max(...values.map((r) => r.length), 0);
  const filled: RangeBounds = {
    startRowIndex: startRow,
    endRowIndex: startRow + values.length,
    startColumnIndex: startColumn,
    endColumnIndex: startColumn + width,
  };

  const ranges = splitByValueInput(filled, values, args, surface, info.title);
  return {
    mode: "range",
    ranges,
    matched: 0,
    inserted: 0,
    placement: `Wrote ${count(values.length, "row")} at ${gridRangeToA1(filled)} on ${info.title}.`,
  };
}

function planAppend(input: PlanInput, isLog: boolean): WritePlan {
  const { args, surface, info } = input;
  const rows = rowsFromArgs(args, surface.headers, isLog, args.timestamp_column);
  if (rows.length === 0) {
    throw err.invalid("Nothing to append: values and records were both empty.");
  }

  const table = tableForData(surface);
  if (table && args.at_row === undefined) {
    const rawColumns = rows[0]
      .map((_, i) => (valueInputFor((table.bounds.startColumnIndex ?? 0) + i, args, surface) === "RAW" ? i : -1))
      .filter((i) => i >= 0);
    const allRaw = rawColumns.length === rows[0].length;
    return {
      mode: isLog ? "log" : "append",
      ranges: [],
      append: {
        tableRange: toA1Reference(info.title, gridRangeToA1(table.bounds)),
        values: rows,
        valueInputOption: allRaw || args.raw === true ? "RAW" : "USER_ENTERED",
        rawColumns: allRaw ? [] : rawColumns,
      },
      matched: 0,
      inserted: rows.length,
      placement: `Appended ${count(rows.length, "row")} into the native Table${table.name ? ` "${table.name}"` : ""} on ${info.title}, which grows to cover them.`,
    };
  }

  if (surface.multipleBlocks && args.at_row === undefined) {
    throw new GsheetsError(
      "invalid_argument",
      `${info.title} holds more than one block of data, so there is no single "end" to append to.`,
      `The first block ends at row ${surface.lastDataRow}. Writing there would land on the blank row that separates the blocks, and appending past everything would land inside the second block. Pass at_row to say exactly where these rows go, or use sheets_structure to insert rows first.`,
      { last_data_row: surface.lastDataRow },
    );
  }

  const startRow = (args.at_row ?? surface.lastDataRow + 1) - 1;
  const startColumn = 0;
  const width = Math.max(...rows.map((r) => r.length), 0);
  const bounds: RangeBounds = {
    startRowIndex: startRow,
    endRowIndex: startRow + rows.length,
    startColumnIndex: startColumn,
    endColumnIndex: startColumn + width,
  };

  return {
    mode: isLog ? "log" : "append",
    ranges: splitByValueInput(bounds, rows, args, surface, info.title),
    matched: 0,
    inserted: rows.length,
    placement: `Appended ${count(rows.length, "row")} at ${gridRangeToA1(bounds)} on ${info.title}, straight after the last row of data.`,
  };
}

async function planUpsert(input: PlanInput): Promise<WritePlan> {
  const { args, surface, info, ctx, spreadsheetId } = input;
  const entries = upsertEntries(args, surface.headers);
  if (entries.length === 0) {
    throw err.invalid(
      "Nothing to upsert: rows and records were both empty.",
      "The batch form is rows: [{ key, set }], which resolves every key from one read and writes once.",
    );
  }

  const keyName = args.key_column ?? surface.contract.keyColumn;
  if (!keyName) {
    throw err.invalid(
      "key_column is required for an upsert and the contract does not name one.",
      surface.headers.length
        ? `The columns are: ${surface.headers.join(", ")}. Pass the one whose value identifies a row.`
        : "This tab has no header row, so an upsert has nothing to match on.",
    );
  }
  const key = resolveColumn(keyName, surface.headers);

  // The key column is read as formatted text, because a key is matched the way
  // a person reads it. Everything else came back as formulas in the surface
  // read, which is right for the guard and wrong for matching a date.
  const keyLetter = columnIndexToLetter(key.index);
  const keyResponse = await withRetry(() =>
    ctx.sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: [`${quoteSheetName(info.title)}!${keyLetter}1:${keyLetter}${SCAN_ROWS}`],
      valueRenderOption: "FORMATTED_VALUE",
      majorDimension: "COLUMNS",
    }),
  );
  const keyColumn = ((keyResponse.data.valueRanges?.[0]?.values ?? [[]])[0] ?? []) as CellValue[];

  const rowByKey = new Map<string, number>();
  const duplicates = new Set<string>();
  for (let i = surface.firstDataRow - 1; i < keyColumn.length && i < surface.lastDataRow; i += 1) {
    const value = String(keyColumn[i] ?? "").trim();
    if (!value) continue;
    const lower = value.toLowerCase();
    if (rowByKey.has(lower)) duplicates.add(value);
    else rowByKey.set(lower, i + 1);
  }
  if (duplicates.size) {
    surface.warnings.push(
      `The key column ${keyLetter} repeats ${listOf([...duplicates].slice(0, 5).map((d) => `"${d}"`))}. An upsert updated the first row for each; the others were left alone.`,
    );
  }

  const updates: Array<{ row: number; columns: Map<number, CellValue> }> = [];
  const inserts: CellValue[][] = [];

  for (const entry of entries) {
    const keyText = String(entry.key ?? "").trim();
    const row = rowByKey.get(keyText.toLowerCase());
    const columns = new Map<number, CellValue>();
    for (const [field, value] of Object.entries(entry.set)) {
      const column = resolveColumn(field, surface.headers);
      columns.set(column.index, value);
    }
    if (row) {
      updates.push({ row, columns });
      continue;
    }
    // A new row carries its key as well as its fields, or it would be a row
    // nothing can find again.
    if (!columns.has(key.index)) columns.set(key.index, entry.key);
    const width = Math.max(surface.headers.length, ...[...columns.keys()].map((i) => i + 1));
    const rowValues: CellValue[] = new Array(width).fill("");
    for (const [index, value] of columns) rowValues[index] = value;
    inserts.push(rowValues);
  }

  const ranges: PlannedRange[] = [];
  for (const update of updates) {
    for (const run of coalesce([...update.columns.keys()])) {
      const values = [
        run.map((index) => update.columns.get(index) ?? ""),
      ];
      const bounds: RangeBounds = {
        startRowIndex: update.row - 1,
        endRowIndex: update.row,
        startColumnIndex: run[0],
        endColumnIndex: run[run.length - 1] + 1,
      };
      ranges.push(...splitByValueInput(bounds, values, args, surface, info.title));
    }
  }

  const plan: WritePlan = {
    mode: "upsert",
    ranges,
    matched: updates.length,
    inserted: inserts.length,
    placement: "",
  };

  if (inserts.length) {
    const table = tableForData(surface);
    if (table) {
      const rawColumns = inserts[0]
        .map((_, i) => (valueInputFor((table.bounds.startColumnIndex ?? 0) + i, args, surface) === "RAW" ? i : -1))
        .filter((i) => i >= 0);
      const allRaw = rawColumns.length === inserts[0].length;
      plan.append = {
        tableRange: toA1Reference(info.title, gridRangeToA1(table.bounds)),
        values: inserts,
        valueInputOption: allRaw || args.raw === true ? "RAW" : "USER_ENTERED",
        rawColumns: allRaw ? [] : rawColumns,
      };
    } else if (surface.multipleBlocks && args.at_row === undefined) {
      throw new GsheetsError(
        "invalid_argument",
        `${count(inserts.length, "row")} did not match an existing key and would have to be appended, but ${info.title} holds more than one block of data.`,
        `The first block ends at row ${surface.lastDataRow}. Pass at_row to say where new rows go, or upsert only the keys that already exist.`,
        { unmatched: inserts.length, last_data_row: surface.lastDataRow },
      );
    } else {
      const startRow = (args.at_row ?? surface.lastDataRow + 1) - 1;
      const width = Math.max(...inserts.map((r) => r.length), 0);
      const bounds: RangeBounds = {
        startRowIndex: startRow,
        endRowIndex: startRow + inserts.length,
        startColumnIndex: 0,
        endColumnIndex: width,
      };
      // The tail block goes into the same batchUpdate as the matched rows, so
      // an upsert is still one write.
      plan.ranges.push(...splitByValueInput(bounds, inserts, args, surface, info.title));
    }
  }

  plan.placement = lines(
    plan.matched
      ? `Matched ${count(plan.matched, "row")} on ${keyLetter} (${key.header ?? keyLetter}) and updated only the named fields.`
      : `No existing row matched on ${keyLetter}.`,
    plan.inserted
      ? `${count(plan.inserted, "row")} did not match and ${plan.inserted === 1 ? "was" : "were"} appended.`
      : undefined,
  );
  return plan;
}

function planFill(input: PlanInput): WritePlan {
  const { args, surface, info } = input;
  const rangeA1 = args.range?.trim();
  if (!rangeA1) {
    throw err.invalid(
      "range is required for mode fill.",
      "Pass the whole region the formula should cover, including the row it starts in, for example E2:E60.",
    );
  }
  const bounds = parseA1(rangeA1);
  if (bounds.startRowIndex === undefined || bounds.endRowIndex === undefined) {
    throw err.invalid(
      `fill needs a range bounded on both ends, and "${rangeA1}" is open.`,
      "Say where the fill stops, for example E2:E60. A whole-column fill would write to the bottom of the sheet.",
    );
  }
  const rows = bounds.endRowIndex - bounds.startRowIndex;
  if (rows < 2) {
    throw err.invalid(
      `"${rangeA1}" is one row, so there is nothing to fill down into.`,
      "The range covers the seed row and every row the formula should reach.",
    );
  }

  const ranges: PlannedRange[] = [];
  if (args.formula) {
    const width = (bounds.endColumnIndex ?? 1) - (bounds.startColumnIndex ?? 0);
    if (width !== 1) {
      throw err.invalid(
        "formula fills one column at a time.",
        `"${rangeA1}" is ${width} columns wide. Call fill once per column, or leave formula out and let the first row of the range be the seed as it already stands.`,
      );
    }
    const seed: RangeBounds = {
      startRowIndex: bounds.startRowIndex,
      endRowIndex: bounds.startRowIndex + 1,
      startColumnIndex: bounds.startColumnIndex ?? 0,
      endColumnIndex: (bounds.startColumnIndex ?? 0) + 1,
    };
    ranges.push({
      range: toA1Reference(info.title, gridRangeToA1(seed)),
      bounds: seed,
      values: [[args.formula]],
      // A formula written RAW is a string that looks like a formula, which is
      // the one case where honouring a TEXT column type would be wrong.
      valueInputOption: "USER_ENTERED",
    });
  }

  const source: RangeBounds = {
    startRowIndex: bounds.startRowIndex,
    endRowIndex: bounds.startRowIndex + 1,
    ...(bounds.startColumnIndex !== undefined ? { startColumnIndex: bounds.startColumnIndex } : {}),
    ...(bounds.endColumnIndex !== undefined ? { endColumnIndex: bounds.endColumnIndex } : {}),
  };

  return {
    mode: "fill",
    ranges,
    fill: { sourceBounds: source, fillLength: rows - 1, sheetId: info.sheetId },
    matched: 0,
    inserted: 0,
    placement: `Filled ${gridRangeToA1(bounds)} on ${info.title} from its first row, so every row's references point at its own row.`,
  };
}

// ---------------------------------------------------------------------------
// Value shaping
// ---------------------------------------------------------------------------

function gridFromArgs(args: WriteArgs, headers: string[], startColumn: number): CellValue[][] {
  if (args.values?.length) return args.values.map((r) => [...r]);
  if (args.records?.length) {
    return args.records.map((record) => recordToRow(record, headers).slice(startColumn));
  }
  return [];
}

function rowsFromArgs(
  args: WriteArgs,
  headers: string[],
  isLog: boolean,
  timestampColumn: string | undefined,
): CellValue[][] {
  let rows: CellValue[][];
  if (args.values?.length) rows = args.values.map((r) => [...r]);
  else if (args.records?.length) rows = args.records.map((record) => recordToRow(record, headers));
  else return [];

  if (!isLog) return rows;

  const index = timestampColumn
    ? resolveColumn(timestampColumn, headers).index
    : headers.findIndex((h) => /^(date|day|when|logged|timestamp|recorded)/i.test(h.trim()));
  const target = index >= 0 ? index : 0;
  const today = new Date().toISOString().slice(0, 10);
  return rows.map((row) => {
    const copy = [...row];
    while (copy.length <= target) copy.push("");
    const existing = String(copy[target] ?? "").trim();
    if (!existing) copy[target] = today;
    return copy;
  });
}

function recordToRow(record: Record<string, CellValue>, headers: string[]): CellValue[] {
  if (headers.length === 0) {
    throw err.invalid(
      "records need a header row to know which column each field belongs in.",
      "Pass header_row to say which row holds the headers, or pass values as rows of cells instead.",
    );
  }
  const row: CellValue[] = new Array(headers.length).fill("");
  for (const [field, value] of Object.entries(record)) {
    const column = resolveColumn(field, headers);
    while (row.length <= column.index) row.push("");
    row[column.index] = value;
  }
  return row;
}

function upsertEntries(
  args: WriteArgs,
  headers: string[],
): Array<{ key: CellValue; set: Record<string, CellValue> }> {
  if (args.rows?.length) return args.rows.map((r) => ({ key: r.key, set: r.set }));
  if (args.records?.length) {
    const keyName = args.key_column;
    if (!keyName) {
      throw err.invalid(
        "records with mode upsert need key_column, so each record can say which row it is.",
        "Or use the batch form, rows: [{ key, set }], which states the key explicitly.",
      );
    }
    const column = resolveColumn(keyName, headers);
    const header = column.header ?? column.letter;
    return args.records.map((record) => {
      const key = record[header] ?? record[column.letter];
      if (key === undefined || key === null || String(key).trim() === "") {
        throw err.invalid(
          `A record has no value in the key column "${header}".`,
          "Every record in an upsert needs its key, or there is no way to know which row it means.",
        );
      }
      return { key, set: record };
    });
  }
  return [];
}

/** A header name or a column letter to a column. */
export function resolveColumn(
  nameOrLetter: string,
  headers: string[],
): { index: number; letter: string; header?: string } {
  const raw = String(nameOrLetter ?? "").trim();
  if (!raw) throw err.invalid("A column was named with an empty string.");

  const lower = raw.toLowerCase();
  const byHeader = headers.findIndex((h) => h.trim().toLowerCase() === lower);
  if (byHeader >= 0) {
    const found: { index: number; letter: string; header?: string } = {
      index: byHeader,
      letter: columnIndexToLetter(byHeader),
    };
    if (headers[byHeader]) found.header = headers[byHeader];
    return found;
  }

  if (/^[A-Za-z]{1,3}$/.test(raw)) {
    const index = columnLetterToIndex(raw);
    const found: { index: number; letter: string; header?: string } = {
      index,
      letter: columnIndexToLetter(index),
    };
    if (headers[index]) found.header = headers[index];
    return found;
  }

  throw err.invalid(
    `No column named "${nameOrLetter}".`,
    headers.length
      ? `The columns on this tab are: ${headers.join(", ")}. A column letter such as C works too.`
      : "This tab has no header row, so name columns by letter.",
  );
}

/** Contiguous runs of column indexes, so one row becomes as few ranges as possible. */
export function coalesce(indexes: number[]): number[][] {
  const sorted = [...new Set(indexes)].sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const index of sorted) {
    const last = runs[runs.length - 1];
    if (last && index === last[last.length - 1] + 1) last.push(index);
    else runs.push([index]);
  }
  return runs;
}

/**
 * Split a block into one planned range per `valueInputOption`.
 *
 * A single `values.update` carries one option for the whole call, so a block
 * spanning a TEXT column and a currency column has to become two writes. The
 * common case is one option for the whole block and one range out.
 */
function splitByValueInput(
  bounds: RangeBounds,
  values: CellValue[][],
  args: WriteArgs,
  surface: Surface,
  sheetName: string,
): PlannedRange[] {
  const startColumn = bounds.startColumnIndex ?? 0;
  const startRow = bounds.startRowIndex ?? 0;
  const width = Math.max(...values.map((r) => r.length), 0);

  const byOption = new Map<ValueInput, number[]>();
  for (let c = 0; c < width; c += 1) {
    const option = valueInputFor(startColumn + c, args, surface);
    const list = byOption.get(option) ?? [];
    list.push(c);
    byOption.set(option, list);
  }

  if (byOption.size <= 1) {
    const option = [...byOption.keys()][0] ?? "USER_ENTERED";
    const full: RangeBounds = {
      startRowIndex: startRow,
      endRowIndex: startRow + values.length,
      startColumnIndex: startColumn,
      endColumnIndex: startColumn + width,
    };
    return [
      {
        range: toA1Reference(sheetName, gridRangeToA1(full)),
        bounds: full,
        values,
        valueInputOption: option,
      },
    ];
  }

  const out: PlannedRange[] = [];
  for (const [option, columns] of byOption) {
    for (const run of coalesce(columns)) {
      const sub: RangeBounds = {
        startRowIndex: startRow,
        endRowIndex: startRow + values.length,
        startColumnIndex: startColumn + run[0],
        endColumnIndex: startColumn + run[run.length - 1] + 1,
      };
      out.push({
        range: toA1Reference(sheetName, gridRangeToA1(sub)),
        bounds: sub,
        values: values.map((row) => run.map((c) => row[c] ?? "")),
        valueInputOption: option,
      });
    }
  }
  return out;
}

/** The Table that covers this tab's data, when there is one. */
function tableForData(surface: Surface): TableInfo | undefined {
  if (surface.tables.length === 0) return undefined;
  if (surface.tables.length === 1) return surface.tables[0];
  // More than one Table on a tab means the caller has to say which, and the
  // honest way to say it is at_row or a range.
  return undefined;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function touchedColumns(plan: WritePlan): number[] {
  const out = new Set<number>();
  for (const range of plan.ranges) {
    const start = range.bounds.startColumnIndex ?? 0;
    const end = range.bounds.endColumnIndex ?? start + 1;
    for (let c = start; c < end; c += 1) out.add(c);
  }
  if (plan.append) {
    const width = Math.max(...plan.append.values.map((r) => r.length), 0);
    for (let c = 0; c < width; c += 1) out.add(c);
  }
  if (plan.fill) {
    const start = plan.fill.sourceBounds.startColumnIndex ?? 0;
    const end = plan.fill.sourceBounds.endColumnIndex ?? start + 1;
    for (let c = start; c < end; c += 1) out.add(c);
  }
  return [...out].sort((a, b) => a - b);
}

/** Why this column is not ours, or undefined when it is. */
function columnRefusal(
  index: number,
  headers: string[],
  contract: SheetContract,
  policy: Policy | undefined,
): string | undefined {
  const letter = columnIndexToLetter(index);
  const header = headers[index]?.trim() || undefined;

  const writability = isColumnWritable(policy, { letter, ...(header ? { header } : {}) });
  if (!writability.writable) return writability.reason;

  const column = contract.columns[index];
  if (column?.owner === "human") {
    return `Column ${letter}${header ? ` ("${header}")` : ""} is marked human owned in this sheet's own metadata. Somebody fills it in by hand.`;
  }
  if (policy && column?.role === "formula") {
    return `Column ${letter}${header ? ` ("${header}")` : ""} is a formula column. Writing values into it breaks the one thing a formula column guarantees, which is that it reads the same all the way down.`;
  }
  return undefined;
}

interface FormulaHit {
  cell: string;
  formula: string;
}

/**
 * Which target cells currently hold formulas.
 *
 * A cell holding the same formula we are about to write is not a collision:
 * re-running a build should not need `force`. Anything else is.
 */
async function findFormulaCollisions(
  ctx: Awaited<ReturnType<ToolDeps["getContext"]>>,
  spreadsheetId: string,
  sheetName: string,
  plan: WritePlan,
): Promise<FormulaHit[]> {
  const targets = plan.ranges.map((r) => r.range);
  // A Table append writes into rows that do not exist yet, so there is nothing
  // to collide with. A fill's destination does need checking.
  if (plan.fill) {
    const bounds = plan.fill.sourceBounds;
    const destination: RangeBounds = {
      startRowIndex: (bounds.startRowIndex ?? 0) + 1,
      endRowIndex: (bounds.startRowIndex ?? 0) + 1 + plan.fill.fillLength,
      ...(bounds.startColumnIndex !== undefined ? { startColumnIndex: bounds.startColumnIndex } : {}),
      ...(bounds.endColumnIndex !== undefined ? { endColumnIndex: bounds.endColumnIndex } : {}),
    };
    targets.push(toA1Reference(sheetName, gridRangeToA1(destination)));
  }
  if (targets.length === 0) return [];

  const response = await withRetry(() =>
    ctx.sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: targets,
      valueRenderOption: "FORMULA",
      majorDimension: "ROWS",
    }),
  );

  const hits: FormulaHit[] = [];
  (response.data.valueRanges ?? []).forEach((valueRange, i) => {
    const planned = plan.ranges[i];
    const grid = (valueRange.values ?? []) as CellValue[][];
    const bounds = planned
      ? planned.bounds
      : plan.fill
        ? {
            startRowIndex: (plan.fill.sourceBounds.startRowIndex ?? 0) + 1,
            startColumnIndex: plan.fill.sourceBounds.startColumnIndex ?? 0,
          }
        : {};
    const startRow = (bounds.startRowIndex ?? 0) + 1;
    const startColumn = bounds.startColumnIndex ?? 0;

    grid.forEach((row, r) => {
      row.forEach((existing, c) => {
        if (typeof existing !== "string" || !existing.startsWith("=")) return;
        const replacement = planned?.values[r]?.[c];
        // A fill has no incoming value per cell; every formula under it is a
        // collision, which is the point of asking before filling over one.
        if (planned && typeof replacement === "string" && replacement === existing) return;
        if (planned && replacement === undefined) return;
        hits.push({
          cell: `${columnIndexToLetter(startColumn + c)}${startRow + r}`,
          formula: existing.length > 60 ? `${existing.slice(0, 57)}...` : existing,
        });
      });
    });
  });
  return hits;
}

function runSafeTextCheck(
  plan: WritePlan,
  sheetName: string,
  policy: Policy | undefined,
): SafeTextFinding[] {
  if (!colleagueSafeApplies(policy)) return [];
  const allowlist = policy?.allowlist ?? [];

  const targets: Array<{ location: string; value: unknown }> = [];
  for (const range of plan.ranges) {
    const startRow = (range.bounds.startRowIndex ?? 0) + 1;
    const startColumn = range.bounds.startColumnIndex ?? 0;
    range.values.forEach((row, r) => {
      row.forEach((value, c) => {
        targets.push({
          location: `${sheetName}!${columnIndexToLetter(startColumn + c)}${startRow + r}`,
          value,
        });
      });
    });
  }
  if (plan.append) {
    plan.append.values.forEach((row, r) => {
      row.forEach((value, c) => {
        targets.push({ location: `${sheetName} new row ${r + 1}, column ${columnIndexToLetter(c)}`, value });
      });
    });
  }
  return checkTexts(targets, { allowlist });
}

// ---------------------------------------------------------------------------
// Executing
// ---------------------------------------------------------------------------

interface WriteResult {
  ranges: string[];
  updatedCells: number;
  updatedRows: number;
  calls: string[];
}

async function execute(
  ctx: Awaited<ReturnType<ToolDeps["getContext"]>>,
  spreadsheetId: string,
  sheetName: string,
  plan: WritePlan,
  args: WriteArgs,
): Promise<WriteResult> {
  const result: WriteResult = { ranges: [], updatedCells: 0, updatedRows: 0, calls: [] };

  // Group the planned ranges by valueInputOption: one values.batchUpdate per
  // option, which is one call in the common case and two at worst.
  const byOption = new Map<ValueInput, PlannedRange[]>();
  for (const range of plan.ranges) {
    const list = byOption.get(range.valueInputOption) ?? [];
    list.push(range);
    byOption.set(range.valueInputOption, list);
  }

  for (const [option, ranges] of byOption) {
    const response = await withRetry(() =>
      ctx.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: option,
          data: ranges.map((r) => ({ range: r.range, majorDimension: "ROWS", values: r.values })),
        },
      }),
    );
    result.calls.push(`values.batchUpdate (${option}, ${count(ranges.length, "range")})`);
    result.updatedCells += response.data.totalUpdatedCells ?? 0;
    result.updatedRows += response.data.totalUpdatedRows ?? 0;
    result.ranges.push(...ranges.map((r) => r.range));
  }

  if (plan.append) {
    const response = await withRetry(() =>
      ctx.sheets.spreadsheets.values.append({
        spreadsheetId,
        range: plan.append!.tableRange,
        valueInputOption: plan.append!.valueInputOption,
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: plan.append!.values as never },
      }),
    );
    result.calls.push("values.append (INSERT_ROWS over the Table's range)");
    const updates = response.data.updates;
    result.updatedCells += updates?.updatedCells ?? 0;
    result.updatedRows += updates?.updatedRows ?? 0;
    const landed = updates?.updatedRange;
    if (landed) result.ranges.push(landed);

    // A Table with a mix of TEXT and other column types cannot be appended in
    // one call, because values.append takes one valueInputOption. So the TEXT
    // columns are corrected in place once the rows have landed and their range
    // is known.
    if (landed && plan.append.rawColumns.length && plan.append.valueInputOption !== "RAW") {
      const bounds = parseA1(landed);
      const startRow = bounds.startRowIndex ?? 0;
      const startColumn = bounds.startColumnIndex ?? 0;
      const data = coalesce(plan.append.rawColumns).map((run) => {
        const sub: RangeBounds = {
          startRowIndex: startRow,
          endRowIndex: startRow + plan.append!.values.length,
          startColumnIndex: startColumn + run[0],
          endColumnIndex: startColumn + run[run.length - 1] + 1,
        };
        return {
          range: toA1Reference(sheetName, gridRangeToA1(sub)),
          majorDimension: "ROWS",
          values: plan.append!.values.map((row) => run.map((c) => row[c] ?? "")),
        };
      });
      await withRetry(() =>
        ctx.sheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: { valueInputOption: "RAW", data },
        }),
      );
      result.calls.push(`values.batchUpdate (RAW, correcting ${count(data.length, "TEXT column range")})`);
    }
  }

  if (plan.fill) {
    await withRetry(() =>
      ctx.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              autoFill: {
                sourceAndDestination: {
                  source: { sheetId: plan.fill!.sheetId, ...plan.fill!.sourceBounds },
                  dimension: "ROWS",
                  fillLength: plan.fill!.fillLength,
                },
              },
            },
          ],
        },
      }),
    );
    result.calls.push("batchUpdate (autoFill)");
    const bounds = plan.fill.sourceBounds;
    const destination: RangeBounds = {
      startRowIndex: bounds.startRowIndex ?? 0,
      endRowIndex: (bounds.startRowIndex ?? 0) + 1 + plan.fill.fillLength,
      ...(bounds.startColumnIndex !== undefined ? { startColumnIndex: bounds.startColumnIndex } : {}),
      ...(bounds.endColumnIndex !== undefined ? { endColumnIndex: bounds.endColumnIndex } : {}),
    };
    result.ranges.push(toA1Reference(sheetName, gridRangeToA1(destination)));
    result.updatedCells += plan.fill.fillLength;
  }

  if (args.note && result.ranges.length) {
    const first = result.ranges[0];
    const bounds = parseA1(first);
    const info = await ctx.cache.resolve(spreadsheetId, sheetName);
    await withRetry(() =>
      ctx.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              repeatCell: {
                range: { sheetId: info.sheetId, ...bounds },
                cell: { note: args.note },
                fields: "note",
              },
            },
          ],
        },
      }),
    );
    result.calls.push("batchUpdate (note)");
  }

  return result;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function safeParse(range: string): RangeBounds | undefined {
  try {
    return parseA1(range);
  } catch {
    return undefined;
  }
}

function describePlan(plan: WritePlan, sheetName: string, written: WriteResult): string {
  const cells = written.updatedCells;
  return `${sheetName}: ${plan.mode} wrote ${count(cells, "cell")} across ${count(written.ranges.length, "range")}, in ${count(written.calls.length, "API call")}.`;
}

function dryRunResponse(
  spreadsheetId: string,
  sheetName: string,
  plan: WritePlan,
  warnings: string[],
  headerRow: number | undefined,
): ToolResponse {
  const preview = plan.ranges.map((r) => ({
    range: r.range,
    value_input: r.valueInputOption,
    rows: r.values.length,
    first_row: r.values[0],
  }));
  const structured: Record<string, unknown> = {
    spreadsheet_id: spreadsheetId,
    sheet: sheetName,
    mode: plan.mode,
    dry_run: true,
    header_row: headerRow ?? null,
    ranges: preview,
    append: plan.append
      ? {
          table_range: plan.append.tableRange,
          rows: plan.append.values.length,
          value_input: plan.append.valueInputOption,
        }
      : null,
    fill: plan.fill ? { fill_length: plan.fill.fillLength } : null,
    matched: plan.matched,
    inserted: plan.inserted,
    warnings,
  };
  return ok(
    lines(
      `Dry run. Nothing was written.`,
      plan.placement,
      preview.length
        ? `Would write:\n${preview.map((p) => `- ${p.range}, ${count(p.rows, "row")}, ${p.value_input}`).join("\n")}`
        : undefined,
      plan.append
        ? `- ${count(plan.append.values.length, "row")} appended into the Table at ${plan.append.tableRange} with values.append and INSERT_ROWS`
        : undefined,
      warnings.length ? `\nWorth knowing:\n${warnings.map((w) => `- ${w}`).join("\n")}` : undefined,
    ),
    structured,
  );
}
