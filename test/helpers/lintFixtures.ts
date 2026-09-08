/**
 * Fixture builders for the lint rules.
 *
 * A rule reads `spreadsheets.get` output, so a fixture has to be that shape, and
 * typing `rowData.values[3].effectiveValue.errorValue.type` by hand for every
 * case makes the interesting part of a test disappear into scaffolding. These
 * builders take a grid of short specs and produce the real shape, so a test can
 * say "row 5 column D holds a #REF" in one line and still exercise the same
 * parsing the live response goes through.
 *
 * Every name here is invented.
 */

import { parseRegistry, type Policy } from "../../src/lib/registry.js";
import { buildContract, type ColumnMetadata, type SheetMetadata } from "../../src/lib/contract.js";
import type { GridRangeLike, LintCell, LintSheet, SheetLintContext } from "../../src/lib/lint/types.js";

export const FIXTURE_SPREADSHEET_ID = "1LiNtFiXtUrEsPrEaDsHeEtIdAbCdEfGhIjKlMnOp";

export interface CellSpec {
  /** The displayed value. */
  value?: string | number | boolean | null;
  /** A formula, which also makes the cell count as a formula cell. */
  formula?: string;
  /** An `ErrorValue.type`, for example "REF" or "LOADING". */
  error?: string;
  errorMessage?: string;
  note?: string;
  bold?: boolean;
  /** Validation help text, which the colleague-safe rule reads. */
  help?: string;
  dropdown?: string[];
}

export type CellInput = CellSpec | string | number | boolean | null | undefined;

function toSpec(input: CellInput): CellSpec {
  if (input === null || input === undefined) return {};
  if (typeof input === "object") return input;
  if (typeof input === "string" && input.startsWith("=")) return { formula: input };
  return { value: input };
}

function toCell(spec: CellSpec): LintCell {
  const cell: LintCell = {};
  if (spec.formula) {
    cell.userEnteredValue = { formulaValue: spec.formula };
  } else if (typeof spec.value === "string") {
    cell.userEnteredValue = { stringValue: spec.value };
  } else if (typeof spec.value === "number") {
    cell.userEnteredValue = { numberValue: spec.value };
  }

  if (spec.error) {
    cell.effectiveValue = { errorValue: { type: spec.error, ...(spec.errorMessage ? { message: spec.errorMessage } : {}) } };
  } else if (typeof spec.value === "string") {
    cell.effectiveValue = { stringValue: spec.value };
    cell.formattedValue = spec.value;
  } else if (typeof spec.value === "number") {
    cell.effectiveValue = { numberValue: spec.value };
    cell.formattedValue = String(spec.value);
  } else if (typeof spec.value === "boolean") {
    cell.effectiveValue = { boolValue: spec.value };
  }

  if (spec.note) cell.note = spec.note;
  if (spec.bold) cell.userEnteredFormat = { textFormat: { bold: true } };
  if (spec.help || spec.dropdown) {
    cell.dataValidation = {
      ...(spec.dropdown
        ? { condition: { type: "ONE_OF_LIST", values: spec.dropdown.map((v) => ({ userEnteredValue: v })) } }
        : {}),
      ...(spec.help ? { inputMessage: spec.help } : {}),
      strict: true,
    };
  }
  return cell;
}

export interface SheetFixtureOptions {
  title: string;
  sheetId?: number;
  frozenRows?: number;
  rows: CellInput[][];
  merges?: GridRangeLike[];
  tables?: Array<{
    tableId?: string;
    name?: string;
    range: GridRangeLike;
    columnProperties?: Array<{ columnIndex: number; columnName: string; columnType?: string }>;
  }>;
  /** Start the grid block somewhere other than A1, as a partial read does. */
  startRow?: number;
  startColumn?: number;
}

/** A `spreadsheets.get` shaped sheet, with grid data. */
export function sheetFixture(options: SheetFixtureOptions): LintSheet {
  const rows = options.rows.map((row) => row.map(toSpec));
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);

  return {
    properties: {
      sheetId: options.sheetId ?? 1,
      title: options.title,
      hidden: false,
      gridProperties: {
        rowCount: Math.max(rows.length, 100),
        columnCount: Math.max(width, 26),
        frozenRowCount: options.frozenRows ?? 0,
        frozenColumnCount: 0,
      },
    },
    merges: options.merges ?? [],
    tables: (options.tables ?? []).map((table, index) => ({
      tableId: table.tableId ?? `t${index}`,
      name: table.name ?? null,
      range: table.range,
      columnProperties: table.columnProperties ?? [],
    })),
    data: [
      {
        startRow: options.startRow ?? 0,
        startColumn: options.startColumn ?? 0,
        rowData: rows.map((row) => ({ values: row.map(toCell) })),
      },
    ],
  };
}

/** The FORMULA rendered grid the same rows would produce. */
export function formulaGrid(rows: CellInput[][]): Array<Array<string | number | boolean | null>> {
  return rows.map((row) =>
    row.map((input) => {
      const spec = toSpec(input);
      if (spec.formula) return spec.formula;
      if (spec.value === undefined || spec.value === null) return "";
      return spec.value;
    }),
  );
}

export interface LintContextOptions extends SheetFixtureOptions {
  policy?: Policy;
  /** Registry JSON, from which the policy for this tab is resolved. */
  registry?: string;
  columnMetadata?: Record<number, ColumnMetadata>;
  sheetMetadata?: SheetMetadata;
  headers?: string[];
  writes?: Array<{ range: string; sheet?: string; at?: number }>;
  /** Leave the FORMULA grid off, as a caller that only had the masked read. */
  withoutFormulas?: boolean;
}

/** A ready to run context: fixture sheet, formula grid, policy and contract. */
export function lintContext(options: LintContextOptions): SheetLintContext {
  const sheet = sheetFixture(options);
  const ctx: SheetLintContext = {
    spreadsheetId: FIXTURE_SPREADSHEET_ID,
    title: options.title,
    sheet,
  };
  if (!options.withoutFormulas) ctx.formulas = formulaGrid(options.rows);

  let policy = options.policy;
  if (!policy && options.registry) {
    policy = parseRegistry(options.registry, "test/.claude/gsheets-pro.json").policyFor(
      FIXTURE_SPREADSHEET_ID,
      options.title,
    );
  }
  if (policy) ctx.policy = policy;

  const columnMetadata = options.columnMetadata
    ? new Map(Object.entries(options.columnMetadata).map(([index, meta]) => [Number(index), meta]))
    : undefined;

  if (policy || columnMetadata || options.sheetMetadata) {
    const headers =
      options.headers ?? formulaGrid(options.rows)[0]?.map((v) => String(v ?? "")) ?? [];
    const input: Parameters<typeof buildContract>[0] = { sheet: options.title, headers };
    if (policy) input.policy = policy;
    if (columnMetadata) input.columnMetadata = columnMetadata;
    if (options.sheetMetadata) input.sheetMetadata = options.sheetMetadata;
    ctx.contract = buildContract(input);
  }

  if (options.writes) {
    ctx.writes = options.writes.map((write) => ({
      range: write.range,
      ...(write.sheet ? { sheet: write.sheet } : {}),
      at: write.at ?? Date.now(),
    }));
  }

  return ctx;
}

/** A registry naming this fixture spreadsheet, for the policy driven rules. */
export function registryJson(entry: Record<string, unknown>): string {
  return JSON.stringify({ spreadsheets: { [FIXTURE_SPREADSHEET_ID]: entry } });
}
