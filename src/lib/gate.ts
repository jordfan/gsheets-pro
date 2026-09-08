/**
 * The error gate: look at what you just wrote.
 *
 * A spreadsheet accepts almost anything and then shows `#REF!` in a cell nobody
 * scrolls to. An agent that writes and moves on has no way to know, so every
 * tool that puts values or formulas into cells finishes by reading the range
 * back and counting the errors it can see.
 *
 * The shape mirrors the recalc check a person would run by eye: how many
 * formulas there are, how many are broken, and which kinds. `LOADING` is not an
 * error, it is a formula still calculating, so the gate waits briefly and then
 * reports `pending` rather than claiming a failure.
 */

import { gridRangeToA1 } from "./a1.js";
import { withRetry } from "./batch.js";

/** The `ErrorValue.type` enum, from the discovery document. */
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

export interface CheckResult {
  status: "clean" | "errors_found" | "pending" | "not_checked";
  total_formulas: number;
  total_errors: number;
  /** Count by `ErrorValue.type`, only the types that occurred. */
  error_summary: Record<string, number>;
  /** Up to ten cells, so a person can go and look. */
  examples: Array<{ cell: string; type: string; message?: string }>;
  note?: string;
}

const GATE_MASK =
  "sheets.properties(sheetId,title),sheets.data(startRow,startColumn,rowData.values(userEnteredValue(formulaValue),effectiveValue(errorValue(type,message))))";

interface GateCapableSheets {
  spreadsheets: {
    get(params: {
      spreadsheetId: string;
      ranges?: string[];
      includeGridData?: boolean;
      fields?: string;
    }): Promise<{ data: unknown }>;
  };
}

export interface GateOptions {
  /** How long to keep waiting on LOADING cells. Default 5000 ms. */
  maxWaitMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Read the ranges back and report what the sheet now says about them. */
export async function checkRanges(
  api: GateCapableSheets,
  spreadsheetId: string,
  ranges: string[],
  options: GateOptions = {},
): Promise<CheckResult> {
  if (ranges.length === 0) {
    return {
      status: "not_checked",
      total_formulas: 0,
      total_errors: 0,
      error_summary: {},
      examples: [],
      note: "Nothing was written, so there was nothing to check.",
    };
  }

  const maxWaitMs = options.maxWaitMs ?? 5000;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + maxWaitMs;
  let waited = 0;

  for (;;) {
    const res = await withRetry(() =>
      api.spreadsheets.get({ spreadsheetId, ranges, includeGridData: true, fields: GATE_MASK }),
    );
    const result = summarize(res.data);
    const stillLoading = (result.error_summary["LOADING"] ?? 0) > 0;
    if (!stillLoading || Date.now() >= deadline) {
      if (stillLoading) {
        return {
          ...result,
          status: "pending",
          note: `Some formulas were still calculating after ${Math.round(waited / 1000)}s. Read the range again in a moment to see the final values.`,
        };
      }
      return result;
    }
    const step = Math.min(1000, Math.max(250, deadline - Date.now()));
    waited += step;
    await sleep(step);
  }
}

function summarize(data: unknown): CheckResult {
  const sheets = (data as { sheets?: unknown[] })?.sheets ?? [];
  const summary: Record<string, number> = {};
  const examples: CheckResult["examples"] = [];
  let formulas = 0;
  let errors = 0;
  let loading = 0;

  for (const sheet of sheets as Array<{
    properties?: { title?: string };
    data?: Array<{
      startRow?: number;
      startColumn?: number;
      rowData?: Array<{ values?: Array<Record<string, unknown>> }>;
    }>;
  }>) {
    const title = sheet.properties?.title ?? "";
    for (const block of sheet.data ?? []) {
      const startRow = block.startRow ?? 0;
      const startColumn = block.startColumn ?? 0;
      (block.rowData ?? []).forEach((row, r) => {
        (row.values ?? []).forEach((cell, c) => {
          const entered = cell["userEnteredValue"] as { formulaValue?: string } | undefined;
          if (entered?.formulaValue) formulas += 1;
          const errorValue = (cell["effectiveValue"] as { errorValue?: { type?: string; message?: string } } | undefined)
            ?.errorValue;
          if (!errorValue?.type) return;
          const type = errorValue.type;
          summary[type] = (summary[type] ?? 0) + 1;
          if (type === "LOADING") {
            loading += 1;
            return;
          }
          errors += 1;
          if (examples.length < 10) {
            const cellA1 = gridRangeToA1({
              startRowIndex: startRow + r,
              endRowIndex: startRow + r + 1,
              startColumnIndex: startColumn + c,
              endColumnIndex: startColumn + c + 1,
            });
            const example: CheckResult["examples"][number] = {
              cell: title ? `${title}!${cellA1}` : cellA1,
              type,
            };
            if (errorValue.message) example.message = errorValue.message;
            examples.push(example);
          }
        });
      });
    }
  }

  return {
    status: errors > 0 ? "errors_found" : loading > 0 ? "pending" : "clean",
    total_formulas: formulas,
    total_errors: errors,
    error_summary: summary,
    examples,
  };
}

/** One line of prose for a check result. */
export function describeCheck(check: CheckResult): string {
  switch (check.status) {
    case "clean":
      return check.total_formulas
        ? `Checked: ${check.total_formulas} formula${check.total_formulas === 1 ? "" : "s"}, no errors.`
        : "Checked: no errors.";
    case "errors_found": {
      const kinds = Object.entries(check.error_summary)
        .filter(([type]) => type !== "LOADING")
        .map(([type, n]) => `${n} ${type}`)
        .join(", ");
      const where = check.examples.map((e) => e.cell).slice(0, 3).join(", ");
      return `Checked: ${check.total_errors} error${check.total_errors === 1 ? "" : "s"} (${kinds}), starting at ${where}.`;
    }
    case "pending":
      return check.note ?? "Checked: some formulas are still calculating.";
    default:
      return check.note ?? "Not checked.";
  }
}
