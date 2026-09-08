/**
 * L20, the key column is blank or duplicated.
 *
 * Every keyed update depends on one column identifying one row. A blank in it
 * means a row that no update can ever reach; a duplicate means an update that
 * silently picks one of two rows, and which one it picks depends on read order.
 * Both are quiet until the day somebody's record does not change and nobody can
 * work out why.
 *
 * The rule only runs when the contract names a key column, either through the
 * sheet's own metadata or through a column whose role is `key`. Inference is
 * not enough: guessing which column is the key and then complaining about it is
 * how a lint earns a reputation for being wrong.
 */

import { columnLetterToIndex } from "../a1.js";
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

/** How many offending rows one finding names before it summarises. */
export const MAX_KEY_ROWS_NAMED = 10;

export const l20KeyColumn: LintRule = {
  id: "L20",
  severity: "warning",
  title: "The key column has a blank or a duplicate",
  run(ctx: SheetLintContext): LintFinding[] {
    const key = keyColumn(ctx);
    if (key === undefined) return [];

    const region = dataRegion(ctx);
    if (region.empty) return [];

    const grid = valueGrid(ctx);
    const blanks: number[] = [];
    const seen = new Map<string, number[]>();

    for (let row = region.firstDataRow; row <= region.lastDataRow; row += 1) {
      const line = grid[row] ?? [];
      const rowIsEmpty = line.every((v) => (v ?? "").toString().trim() === "");
      if (rowIsEmpty) continue;

      const value = gridValue(grid, row, key.index).trim();
      if (value === "") {
        blanks.push(row);
        continue;
      }
      const bucket = seen.get(value.toLowerCase()) ?? [];
      bucket.push(row);
      seen.set(value.toLowerCase(), bucket);
    }

    const duplicates = [...seen.entries()].filter(([, rows]) => rows.length > 1);
    if (blanks.length === 0 && duplicates.length === 0) return [];

    const named = key.header ? `"${key.header}" (column ${key.letter})` : `column ${key.letter}`;
    const findings: LintFinding[] = [];

    if (blanks.length > 0) {
      findings.push({
        rule: "L20",
        severity: "warning",
        location: lintLocation(ctx.title, rowsRange(key.letter, blanks)),
        message: `The key column ${named} on ${ctx.title} is blank on ${listRows(ctx.title, key.letter, blanks)}. A row with no key cannot be reached by an update that matches on it.`,
        fix: `Fill the blank. sheets_write with a rows batch keyed on ${key.header ?? key.letter}, or read the row and work out what its key should be. Do not switch to matching on row numbers.`,
      });
    }

    for (const [value, rows] of duplicates.slice(0, MAX_KEY_ROWS_NAMED)) {
      findings.push({
        rule: "L20",
        severity: "warning",
        location: lintLocation(ctx.title, rowsRange(key.letter, rows)),
        message: `The key column ${named} on ${ctx.title} holds "${displayValue(grid, key.index, rows)}" on ${listRows(ctx.title, key.letter, rows)}. An update keyed on it would pick one of those rows and the choice depends on read order.`,
        fix: `Resolve the duplicate: merge the two rows, or make the key genuinely unique. Matching on row numbers instead would break the next time somebody sorts the tab. (Value compared without regard to case: "${value}".)`,
      });
    }

    if (duplicates.length > MAX_KEY_ROWS_NAMED) {
      findings.push({
        rule: "L20",
        severity: "warning",
        location: lintLocation(ctx.title, `${key.letter}:${key.letter}`),
        message: `And ${duplicates.length - MAX_KEY_ROWS_NAMED} more repeated value(s) in the key column on ${ctx.title}.`,
        fix: `sheets_read the ${key.header ?? key.letter} column and sort out the duplicates before any keyed update runs against this tab.`,
      });
    }

    return findings;
  },
};

interface KeyColumn {
  index: number;
  letter: string;
  header?: string;
}

/** The contract's key column: named on the sheet metadata, or a `key` role. */
function keyColumn(ctx: SheetLintContext): KeyColumn | undefined {
  const contract = ctx.contract;
  if (!contract) return undefined;

  const roleColumns = columnsWithRole(contract, "key");
  if (roleColumns.length > 0) return roleColumns[0];

  const named = contract.keyColumn?.trim();
  if (!named) return undefined;

  // The metadata may name the column by letter or by header text.
  const byHeader = contract.columns.find(
    (column) => column.header && column.header.trim().toLowerCase() === named.toLowerCase(),
  );
  if (byHeader) {
    const out: KeyColumn = { index: byHeader.index, letter: byHeader.letter };
    if (byHeader.header) out.header = byHeader.header;
    return out;
  }
  try {
    const index = columnLetterToIndex(named);
    const column = contract.columns.find((c) => c.index === index);
    const out: KeyColumn = { index, letter: named.toUpperCase() };
    if (column?.header) out.header = column.header;
    return out;
  } catch {
    return undefined;
  }
}

function rowsRange(letter: string, rows: number[]): string {
  const first = Math.min(...rows);
  const last = Math.max(...rows);
  return first === last ? `${letter}${first + 1}` : `${letter}${first + 1}:${letter}${last + 1}`;
}

function listRows(title: string, letter: string, rows: number[]): string {
  const shown = rows.slice(0, MAX_KEY_ROWS_NAMED).map((row) => lintLocation(title, cellA1(row, columnLetterToIndex(letter))));
  const rest = rows.length - shown.length;
  const list = shown.join(", ");
  return rest > 0 ? `${list} and ${rest} more` : list;
}

function displayValue(grid: string[][], column: number, rows: number[]): string {
  const first = rows[0];
  return gridValue(grid, first, column).trim();
}
