/**
 * What a lint rule is, and the shapes it reads.
 *
 * Every rule is a pure function over one tab's worth of `spreadsheets.get`
 * output plus the extras that call carries alongside it: the FORMULA rendered
 * values, the registry policy, the contract, and the ranges this process wrote.
 * Nothing in here talks to Google. That is the whole point: a rule is testable
 * against a fixture somebody typed by hand, so the interesting cases (a merge
 * straddling a header, a key column with two identical emails) can be written
 * down rather than reproduced on a live spreadsheet.
 *
 * The shapes below are deliberately the API's own, loosened to the parts the
 * mask asks for. A fixture is a slice of a real response, not a translation of
 * one, so a rule that works here works there.
 */
import { columnIndexToLetter, quoteSheetName } from "../a1.js";
// ---------------------------------------------------------------------------
// Reading the shapes
// ---------------------------------------------------------------------------
/**
 * "Roster!A1:J1", quoting the tab only when it needs it.
 *
 * A quoted name is always correct and always uglier, and these strings are read
 * by a person as often as they are pasted, so the quotes go on only when a bare
 * name would not parse.
 */
export function lintLocation(title, range) {
    const safe = /^[A-Za-z_][A-Za-z0-9_]*$/.test(title) ? title : quoteSheetName(title);
    const body = String(range ?? "").trim();
    return body ? `${safe}!${body}` : safe;
}
/** Zero based row and column to A1: (13, 3) -> "D14". */
export function cellA1(row, column) {
    return `${columnIndexToLetter(column)}${row + 1}`;
}
/** Zero based half open bounds to A1: rows 0..1, cols 0..10 -> "A1:J1". */
export function boundsA1(startRow, endRow, startColumn, endColumn) {
    const first = cellA1(startRow, startColumn);
    const last = cellA1(Math.max(startRow, endRow - 1), Math.max(startColumn, endColumn - 1));
    return first === last ? first : `${first}:${last}`;
}
/** A GridRange to A1 within its own tab, tolerating the open ended form. */
export function gridRangeA1(range) {
    if (!range)
        return "";
    const startRow = range.startRowIndex ?? 0;
    const startColumn = range.startColumnIndex ?? 0;
    const endRow = range.endRowIndex ?? startRow + 1;
    const endColumn = range.endColumnIndex ?? startColumn + 1;
    return boundsA1(startRow, endRow, startColumn, endColumn);
}
/**
 * Walk every cell the response actually carried, in absolute sheet coordinates.
 * `data` blocks are sparse and each one states where it starts, so the offsets
 * matter: getting them wrong reports the right problem at the wrong address,
 * which is worse than not reporting it.
 */
export function eachCell(sheet, visit) {
    for (const block of sheet.data ?? []) {
        const startRow = block?.startRow ?? 0;
        const startColumn = block?.startColumn ?? 0;
        const rows = block?.rowData ?? [];
        for (let r = 0; r < rows.length; r += 1) {
            const values = rows[r]?.values ?? [];
            for (let c = 0; c < values.length; c += 1) {
                const cell = values[c];
                if (cell)
                    visit({ row: startRow + r, column: startColumn + c, cell });
            }
        }
    }
}
/** One cell out of the sparse blocks, or undefined when the read skipped it. */
export function cellAt(sheet, row, column) {
    for (const block of sheet.data ?? []) {
        const startRow = block?.startRow ?? 0;
        const startColumn = block?.startColumn ?? 0;
        const rows = block?.rowData ?? [];
        const r = row - startRow;
        const c = column - startColumn;
        if (r < 0 || c < 0 || r >= rows.length)
            continue;
        const values = rows[r]?.values ?? [];
        if (c >= values.length)
            continue;
        const cell = values[c];
        if (cell)
            return cell;
    }
    return undefined;
}
/** The text a person would see in a cell, from whichever field carried it. */
export function cellText(cell) {
    if (!cell)
        return "";
    if (typeof cell.formattedValue === "string")
        return cell.formattedValue;
    const effective = cell.effectiveValue;
    if (effective) {
        if (typeof effective.stringValue === "string")
            return effective.stringValue;
        if (typeof effective.numberValue === "number")
            return String(effective.numberValue);
        if (typeof effective.boolValue === "boolean")
            return String(effective.boolValue).toUpperCase();
    }
    const entered = cell.userEnteredValue;
    if (entered && typeof entered.stringValue === "string")
        return entered.stringValue;
    return "";
}
/** True when the cell holds a formula rather than a typed value. */
export function isFormulaCell(cell) {
    return typeof cell?.userEnteredValue?.formulaValue === "string";
}
export function frozenRowCount(sheet) {
    return sheet.properties?.gridProperties?.frozenRowCount ?? 0;
}
const looksNumeric = (value) => value.trim() !== "" && Number.isFinite(Number(value.replace(/[$,%\s]/g, "")));
/**
 * The grid the value rules read: FORMULA rendered values when the call carried
 * them, otherwise whatever text the masked read happened to include.
 */
export function valueGrid(ctx) {
    if (ctx.formulas) {
        return ctx.formulas.map((row) => (row ?? []).map((v) => (v == null ? "" : String(v))));
    }
    const grid = [];
    eachCell(ctx.sheet, ({ row, column, cell }) => {
        const line = (grid[row] ??= []);
        line[column] = cellText(cell);
    });
    return grid.map((row) => (row ?? []).map((v) => v ?? ""));
}
export function gridValue(grid, row, column) {
    return (grid[row]?.[column] ?? "").toString();
}
/**
 * Which row holds the headers, zero based.
 *
 * In order of confidence: the contract says so, the tab has a native Table and
 * its range starts there, the frozen rows say so, the first row is bold, or the
 * first row that reads like words rather than numbers. Undefined when no row
 * looks like a header at all, which is a real answer for a scratch tab.
 */
export function headerRowIndex(ctx) {
    if (ctx.contract?.headerRow && ctx.contract.headerRow > 0)
        return ctx.contract.headerRow - 1;
    const table = (ctx.sheet.tables ?? [])[0];
    if (table?.range && table.range.startRowIndex != null)
        return table.range.startRowIndex;
    const frozen = frozenRowCount(ctx.sheet);
    if (frozen > 0)
        return frozen - 1;
    const grid = valueGrid(ctx);
    if (firstRowIsBold(ctx.sheet))
        return 0;
    for (let r = 0; r < Math.min(grid.length, 10); r += 1) {
        const filled = (grid[r] ?? []).filter((v) => v.trim() !== "");
        if (filled.length < 2)
            continue;
        if (filled.every((v) => !looksNumeric(v)))
            return r;
    }
    return undefined;
}
/** True when the first row is bold across the cells that carry anything. */
export function firstRowIsBold(sheet) {
    let filled = 0;
    let bold = 0;
    for (const block of sheet.data ?? []) {
        const startRow = block?.startRow ?? 0;
        if (startRow > 0)
            continue;
        const values = (block?.rowData ?? [])[0]?.values ?? [];
        for (const cell of values) {
            if (!cell)
                continue;
            if (cellText(cell).trim() === "" && !isFormulaCell(cell))
                continue;
            filled += 1;
            if (cell.userEnteredFormat?.textFormat?.bold === true)
                bold += 1;
        }
    }
    return filled >= 2 && bold === filled;
}
/**
 * The block of the tab that holds data: from the header row down to the last
 * row carrying anything, across the columns that carry anything.
 *
 * This is what "in a data region" means for the merge rule. A merged title sat
 * above the header row is outside it, which is exactly the arrangement the fix
 * string recommends, so the rule has to be able to tell the two apart.
 */
export function dataRegion(ctx) {
    const grid = valueGrid(ctx);
    const header = headerRowIndex(ctx);
    const start = header ?? 0;
    let lastRow = -1;
    let firstColumn = Number.POSITIVE_INFINITY;
    let lastColumn = -1;
    for (let r = start; r < grid.length; r += 1) {
        const row = grid[r] ?? [];
        for (let c = 0; c < row.length; c += 1) {
            if ((row[c] ?? "").toString().trim() === "")
                continue;
            if (r > lastRow)
                lastRow = r;
            if (c < firstColumn)
                firstColumn = c;
            if (c > lastColumn)
                lastColumn = c;
        }
    }
    // A native Table states its own extent, and it wins where it exists: a Table
    // covering empty rows still owns them.
    for (const table of ctx.sheet.tables ?? []) {
        const range = table?.range;
        if (!range)
            continue;
        const tableLastRow = (range.endRowIndex ?? 0) - 1;
        const tableFirstColumn = range.startColumnIndex ?? 0;
        const tableLastColumn = (range.endColumnIndex ?? 0) - 1;
        if (tableLastRow > lastRow)
            lastRow = tableLastRow;
        if (tableFirstColumn < firstColumn)
            firstColumn = tableFirstColumn;
        if (tableLastColumn > lastColumn)
            lastColumn = tableLastColumn;
    }
    const empty = lastRow < 0 || lastColumn < 0;
    const region = {
        firstDataRow: header !== undefined ? header + 1 : start,
        lastDataRow: empty ? start : lastRow,
        firstColumn: empty ? 0 : firstColumn,
        lastColumn: empty ? 0 : lastColumn,
        empty,
    };
    if (header !== undefined)
        region.headerRow = header;
    return region;
}
/** Half open row and column bounds overlap. */
export function rangesOverlap(a, b) {
    const aStartRow = a.startRowIndex ?? 0;
    const aEndRow = a.endRowIndex ?? Number.MAX_SAFE_INTEGER;
    const bStartRow = b.startRowIndex ?? 0;
    const bEndRow = b.endRowIndex ?? Number.MAX_SAFE_INTEGER;
    const aStartCol = a.startColumnIndex ?? 0;
    const aEndCol = a.endColumnIndex ?? Number.MAX_SAFE_INTEGER;
    const bStartCol = b.startColumnIndex ?? 0;
    const bEndCol = b.endColumnIndex ?? Number.MAX_SAFE_INTEGER;
    return aStartRow < bEndRow && bStartRow < aEndRow && aStartCol < bEndCol && bStartCol < aEndCol;
}
/** Which column a contract role sits on, by letter. */
export function columnsWithRole(contract, role) {
    if (!contract)
        return [];
    return contract.columns
        .filter((column) => column.role === role)
        .map((column) => {
        const out = {
            index: column.index,
            letter: column.letter,
        };
        if (column.header)
            out.header = column.header;
        return out;
    });
}
//# sourceMappingURL=types.js.map