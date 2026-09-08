/**
 * L22, the sheet's own Check column is flagging something.
 *
 * A tracker built the way the style guide asks for has a Check column: a
 * formula that says, in words, what is missing from a row. When it is non-blank
 * the spreadsheet is telling you about itself, in the vocabulary its own author
 * chose, which is better information than any generic rule could produce.
 *
 * So this rule does almost nothing. It finds the column the contract marks with
 * the role `check`, reports the rows where it says something, and quotes what
 * it says. The fix is to do what the column says, which is nearly always a
 * missing input rather than a broken formula.
 */

import {
  cellA1,
  columnsWithRole,
  dataRegion,
  gridValue,
  lintLocation,
  valueGrid,
  type LintFinding,
  type LintRule,
  type SheetLintContext,
} from "./types.js";

/** How many flagged rows one finding quotes before it counts the rest. */
export const MAX_CHECK_ROWS_NAMED = 8;

export const l22CheckColumn: LintRule = {
  id: "L22",
  severity: "warning",
  title: "The Check column is flagging rows",
  run(ctx: SheetLintContext): LintFinding[] {
    const columns = columnsWithRole(ctx.contract, "check");
    if (columns.length === 0) return [];

    const region = dataRegion(ctx);
    if (region.empty) return [];

    const grid = valueGrid(ctx);
    const findings: LintFinding[] = [];

    for (const column of columns) {
      const flagged: Array<{ row: number; text: string }> = [];

      for (let row = region.firstDataRow; row <= region.lastDataRow; row += 1) {
        const raw = gridValue(grid, row, column.index).trim();
        if (raw === "") continue;
        // The FORMULA render shows the formula rather than what it produced, so
        // a formula cell is only evidence when the masked read saw its value.
        if (raw.startsWith("=")) {
          const text = displayedText(ctx, row, column.index);
          if (text.trim() === "") continue;
          flagged.push({ row, text: text.trim() });
          continue;
        }
        flagged.push({ row, text: raw });
      }

      if (flagged.length === 0) continue;

      const shown = flagged.slice(0, MAX_CHECK_ROWS_NAMED);
      const rest = flagged.length - shown.length;
      const named = column.header ? `"${column.header}" (column ${column.letter})` : `column ${column.letter}`;
      const quoted = shown
        .map((entry) => `${lintLocation(ctx.title, cellA1(entry.row, column.index))} "${truncate(entry.text)}"`)
        .join("; ");

      findings.push({
        rule: "L22",
        severity: "warning",
        location: lintLocation(
          ctx.title,
          `${column.letter}${Math.min(...flagged.map((f) => f.row)) + 1}:${column.letter}${Math.max(...flagged.map((f) => f.row)) + 1}`,
        ),
        message: `The Check column ${named} on ${ctx.title} is flagging ${flagged.length} row(s): ${quoted}${
          rest > 0 ? `; and ${rest} more` : ""
        }. The spreadsheet is telling you about itself.`,
        fix: `Resolve what the column says, row by row. It is usually a missing input rather than a formula bug, so sheets_read the flagged rows and fill what is absent. Do not clear the column.`,
      });
    }

    return findings;
  },
};

/** What the masked read saw in the cell, when it read that far. */
function displayedText(ctx: SheetLintContext, row: number, column: number): string {
  for (const block of ctx.sheet.data ?? []) {
    const startRow = block?.startRow ?? 0;
    const startColumn = block?.startColumn ?? 0;
    const cell = (block?.rowData ?? [])[row - startRow]?.values?.[column - startColumn];
    if (!cell) continue;
    if (typeof cell.formattedValue === "string") return cell.formattedValue;
    const value = cell.effectiveValue;
    if (value && typeof value.stringValue === "string") return value.stringValue;
    if (value && typeof value.numberValue === "number") return String(value.numberValue);
  }
  return "";
}

function truncate(text: string, limit = 80): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
