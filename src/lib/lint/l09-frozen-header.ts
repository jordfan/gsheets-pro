/**
 * L09, no frozen header.
 *
 * A tab with a header row and no frozen rows scrolls its own labels off the
 * screen. Everyone who opens it past row 30 is reading a grid of values with no
 * idea which column is which, and the fix is one call that nobody ever regrets.
 *
 * The rule fires on the two cases where a header row is certain rather than
 * guessed: the tab has a native Table, or its first row is bold. A tab whose
 * header was only inferred from the text looking like words is left alone,
 * because a lint that nags about a scratch tab is a lint people switch off.
 */

import {
  boundsA1,
  firstRowIsBold,
  frozenRowCount,
  lintLocation,
  valueGrid,
  type LintFinding,
  type LintRule,
  type SheetLintContext,
} from "./types.js";

export const l09FrozenHeader: LintRule = {
  id: "L09",
  severity: "warning",
  title: "A header row that is not frozen",
  run(ctx: SheetLintContext): LintFinding[] {
    if (frozenRowCount(ctx.sheet) > 0) return [];

    const tables = (ctx.sheet.tables ?? []).filter(Boolean);
    const bold = firstRowIsBold(ctx.sheet);
    const contractHeader = ctx.contract?.headerRow;
    if (tables.length === 0 && !bold && !contractHeader) return [];

    const grid = valueGrid(ctx);
    const headerIndex = contractHeader ? contractHeader - 1 : (tables[0]?.range?.startRowIndex ?? 0);
    const width = Math.max(1, (grid[headerIndex] ?? []).filter((v) => v.trim() !== "").length);
    const range = boundsA1(headerIndex, headerIndex + 1, 0, width);
    const where = lintLocation(ctx.title, range);

    const why =
      tables.length > 0
        ? `The ${ctx.title} tab has a Table but no frozen header row.`
        : bold
          ? `The ${ctx.title} tab has a bold header row that is not frozen.`
          : `The ${ctx.title} tab's contract names row ${headerIndex + 1} as the header, and it is not frozen.`;

    return [
      {
        rule: "L09",
        severity: "warning",
        location: where,
        message: `${why} It scrolls out of view, so anyone reading past the first screen is looking at unlabelled columns.`,
        fix: `sheets_style with sheet: "${ctx.title}", freeze_rows: ${headerIndex + 1}`,
      },
    ];
  },
};
