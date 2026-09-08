/**
 * The error gate: what every write reports back about what it just did.
 *
 * A write that returns "updated 40 cells" and nothing else is how an agent
 * fills a column with `#REF!` and calls it done. So the last thing every write
 * does is read back the range it touched and say whether the sheet still
 * evaluates. The shape is deliberately the one `sheets_check` uses, keyed on
 * the Sheets `ErrorValue.type` enum, which is locale independent: a French
 * user's `#NOM?` and an English user's `#NAME?` both arrive as `NAME`.
 *
 * `LOADING` is the interesting case. It is not an error; it is a cell whose
 * `IMPORTRANGE` or `GOOGLEFINANCE` has not come back yet. Reporting it as an
 * error would teach the model to panic over a sheet that is fine a second
 * later, so the gate waits for it, briefly, and then says `pending` rather
 * than pretending to know.
 */

import { columnIndexToLetter, gridRangeToA1, rangeCellCount, type NullableBounds } from "./a1.js";
import { withRetry } from "./batch.js";

/** The nine values `ErrorValue.type` can take. */
export const ERROR_VALUE_TYPES = [
  "ERROR",
  "NULL_VALUE",
  "DIVIDE_BY_ZERO",
  "VALUE",
  "REF",
  "NAME",
  "NUM",
  "N_A",
  "LOADING",
] as const;

export type ErrorValueType = (typeof ERROR_VALUE_TYPES)[number];

export type CheckStatus = "success" | "errors_found" | "pending";

export interface ErrorSummaryEntry {
  count: number;
  /** Up to `LOCATION_CAP` A1 references, so a broken column is diagnosable. */
  locations: string[];
  /** How many locations were not listed. */
  truncated: number;
}

export interface CheckResult {
  status: CheckStatus;
  total_formulas: number;
  total_errors: number;
  error_summary: Record<string, ErrorSummaryEntry>;
  /** Set when the gate declined to run, with the reason. */
  skipped?: string;
  /** How long the gate waited for LOADING cells, in milliseconds. */
  waited_ms?: number;
}

/** Locations listed per error type before the rest are counted only. */
export const LOCATION_CAP = 20;

/** Past this many cells the gate is a read worth more than it teaches. */
export const GATE_CELL_CAP = 20_000;

/** LOADING is retried for about this long before the gate gives up on it. */
export const LOADING_BUDGET_MS = 5_000;

const GATE_MASK = [
  "sheets.properties(sheetId,title)",
  "sheets.data(startRow,startColumn,rowData.values(",
  "userEnteredValue.formulaValue,",
  "effectiveValue.errorValue.type",
  "))",
].join("");

/** The narrow slice of the client the gate needs, so tests can fake it. */
export interface GateCapableSheets {
  spreadsheets: {
    get(params: {
      spreadsheetId: string;
      ranges?: string[];
      includeGridData?: boolean;
      fields?: string;
    }): Promise<{ data: unknown }>;
  };
}

interface GridCell {
  userEnteredValue?: { formulaValue?: string | null } | null;
  effectiveValue?: { errorValue?: { type?: string | null } | null } | null;
}

interface GridSheet {
  properties?: { title?: string | null } | null;
  data?: Array<{
    startRow?: number | null;
    startColumn?: number | null;
    rowData?: Array<{ values?: GridCell[] | null } | null> | null;
  } | null> | null;
}

/**
 * Count formulas and error values over the grid a masked get returned.
 * Exported because it is pure, which is where the tests live.
 */
export function summarizeGrid(sheets: GridSheet[]): {
  totalFormulas: number;
  errors: Map<string, string[]>;
} {
  let totalFormulas = 0;
  const errors = new Map<string, string[]>();

  for (const sheet of sheets) {
    const title = sheet.properties?.title ?? "";
    for (const block of sheet.data ?? []) {
      if (!block) continue;
      const startRow = block.startRow ?? 0;
      const startColumn = block.startColumn ?? 0;
      (block.rowData ?? []).forEach((row, r) => {
        (row?.values ?? []).forEach((cell, c) => {
          if (cell?.userEnteredValue?.formulaValue) totalFormulas += 1;
          const type = cell?.effectiveValue?.errorValue?.type;
          if (!type) return;
          const a1 = `${columnIndexToLetter(startColumn + c)}${startRow + r + 1}`;
          const where = title ? `${title}!${a1}` : a1;
          const list = errors.get(type) ?? [];
          list.push(where);
          errors.set(type, list);
        });
      });
    }
  }
  return { totalFormulas, errors };
}

function toResult(
  totalFormulas: number,
  errors: Map<string, string[]>,
  waitedMs: number,
): CheckResult {
  const summary: Record<string, ErrorSummaryEntry> = {};
  let totalErrors = 0;
  let loading = 0;

  for (const [type, locations] of errors) {
    summary[type] = {
      count: locations.length,
      locations: locations.slice(0, LOCATION_CAP),
      truncated: Math.max(0, locations.length - LOCATION_CAP),
    };
    if (type === "LOADING") loading += locations.length;
    else totalErrors += locations.length;
  }

  const status: CheckStatus =
    totalErrors > 0 ? "errors_found" : loading > 0 ? "pending" : "success";

  const result: CheckResult = {
    status,
    total_formulas: totalFormulas,
    total_errors: totalErrors,
    error_summary: summary,
  };
  if (waitedMs > 0) result.waited_ms = waitedMs;
  return result;
}

export interface RunGateOptions {
  /** Skip the read and say why. */
  skip?: string;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Override the LOADING budget, for tests. */
  loadingBudgetMs?: number;
  /** Refuse to read more than this many cells. */
  cellCap?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Read back the ranges a write touched and report whether the sheet evaluates.
 *
 * `ranges` are fully qualified A1 references, the same strings the write sent.
 * They are read in one masked `spreadsheets.get`, which costs one read from a
 * sixty per minute budget no matter how many ranges are in it.
 */
export async function runGate(
  api: GateCapableSheets,
  spreadsheetId: string,
  ranges: string[],
  options: RunGateOptions = {},
): Promise<CheckResult> {
  if (options.skip) {
    return {
      status: "success",
      total_formulas: 0,
      total_errors: 0,
      error_summary: {},
      skipped: options.skip,
    };
  }
  const wanted = [...new Set(ranges.filter((r) => typeof r === "string" && r.trim()))];
  if (wanted.length === 0) {
    return {
      status: "success",
      total_formulas: 0,
      total_errors: 0,
      error_summary: {},
      skipped: "Nothing was written, so there was nothing to read back.",
    };
  }

  const sleep = options.sleep ?? defaultSleep;
  const budget = options.loadingBudgetMs ?? LOADING_BUDGET_MS;
  const started = Date.now();
  let waited = 0;
  let delay = 400;

  for (;;) {
    const response = await withRetry(() =>
      api.spreadsheets.get({
        spreadsheetId,
        ranges: wanted,
        includeGridData: true,
        fields: GATE_MASK,
      }),
    );
    const sheets = ((response.data as { sheets?: GridSheet[] } | undefined)?.sheets ?? []) as GridSheet[];
    const { totalFormulas, errors } = summarizeGrid(sheets);

    const stillLoading = (errors.get("LOADING") ?? []).length > 0;
    if (!stillLoading || waited >= budget) {
      return toResult(totalFormulas, errors, Date.now() - started);
    }
    const step = Math.min(delay, budget - waited);
    await sleep(step);
    waited += step;
    delay *= 2;
  }
}

/** True when a range is small enough to be worth reading back. */
export function withinGateCap(bounds: NullableBounds, cap = GATE_CELL_CAP): boolean {
  const cells = rangeCellCount(bounds);
  return cells !== undefined && cells <= cap;
}

/** One sentence a person would say about a gate result. */
export function describeCheck(check: CheckResult): string {
  if (check.skipped) return `No error check was run: ${check.skipped}`;
  if (check.status === "errors_found") {
    const parts = Object.entries(check.error_summary)
      .filter(([type]) => type !== "LOADING")
      .map(([type, entry]) => `${entry.count} ${type} (${entry.locations.slice(0, 3).join(", ")})`);
    return `The sheet has ${check.total_errors} error ${check.total_errors === 1 ? "cell" : "cells"} in the range that was written: ${parts.join(", ")}. Fix these before calling the work done.`;
  }
  if (check.status === "pending") {
    return `Some cells were still calculating after ${Math.round((check.waited_ms ?? 0) / 100) / 10} seconds, so this is pending rather than clean. Read the range again in a moment.`;
  }
  return check.total_formulas > 0
    ? `Checked: ${check.total_formulas} ${check.total_formulas === 1 ? "formula" : "formulas"} in the written range, no errors.`
    : "Checked: no errors in the written range.";
}

/** A1 for a bounds object, for building gate ranges. */
export function boundsToA1(bounds: NullableBounds): string {
  return gridRangeToA1(bounds);
}
