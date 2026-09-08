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
import type { Policy } from "../registry.js";
import type { SheetContract } from "../contract.js";
export type LintSeverity = "error" | "warning" | "info";
/** One thing worth telling somebody about, and the call that fixes it. */
export interface LintFinding {
    /** The rule id from `references/lint-rules.md`, for example "L09". */
    rule: string;
    severity: LintSeverity;
    /** Where, as an A1 reference somebody can paste into the name box. */
    location: string;
    message: string;
    /** The call that resolves it, named specifically enough to run. */
    fix: string;
}
export interface GridRangeLike {
    sheetId?: number | null;
    startRowIndex?: number | null;
    endRowIndex?: number | null;
    startColumnIndex?: number | null;
    endColumnIndex?: number | null;
}
export interface LintExtendedValue {
    stringValue?: string | null;
    numberValue?: number | null;
    boolValue?: boolean | null;
    formulaValue?: string | null;
    errorValue?: {
        type?: string | null;
        message?: string | null;
    } | null;
}
export interface LintCell {
    userEnteredValue?: LintExtendedValue | null;
    effectiveValue?: LintExtendedValue | null;
    formattedValue?: string | null;
    note?: string | null;
    userEnteredFormat?: {
        textFormat?: {
            bold?: boolean | null;
        } | null;
    } | null;
    dataValidation?: {
        condition?: {
            type?: string | null;
            values?: Array<{
                userEnteredValue?: string | null;
            }> | null;
        } | null;
        strict?: boolean | null;
        inputMessage?: string | null;
    } | null;
}
export interface LintGridBlock {
    startRow?: number | null;
    startColumn?: number | null;
    rowData?: Array<{
        values?: LintCell[] | null;
    }> | null;
}
export interface LintTable {
    tableId?: string | null;
    name?: string | null;
    range?: GridRangeLike | null;
    columnProperties?: Array<{
        columnIndex?: number | null;
        columnName?: string | null;
        columnType?: string | null;
        dataValidationRule?: unknown;
    }> | null;
}
export interface LintSheet {
    properties?: {
        sheetId?: number | null;
        title?: string | null;
        hidden?: boolean | null;
        gridProperties?: {
            rowCount?: number | null;
            columnCount?: number | null;
            frozenRowCount?: number | null;
            frozenColumnCount?: number | null;
        } | null;
    } | null;
    data?: LintGridBlock[] | null;
    merges?: GridRangeLike[] | null;
    tables?: LintTable[] | null;
    bandedRanges?: unknown[] | null;
    protectedRanges?: unknown[] | null;
}
export interface LintSpreadsheet {
    spreadsheetId?: string | null;
    properties?: {
        title?: string | null;
    } | null;
    sheets?: LintSheet[] | null;
}
/** A range this process wrote, for the rule that asks where the writes landed. */
export interface WriteRecord {
    /** Fully qualified A1, for example "'Roster'!D2:D40". */
    range: string;
    /** The tab, already split out. */
    sheet?: string;
    /** Which tool wrote it. */
    tool?: string;
    /** Epoch milliseconds. */
    at: number;
}
/** Everything one rule sees. One tab, plus what came with the call. */
export interface SheetLintContext {
    spreadsheetId: string;
    title: string;
    sheet: LintSheet;
    /**
     * FORMULA rendered values for this tab, row major from A1. A formula cell
     * holds its formula text; everything else holds its unformatted value. This
     * is the cheap way to see both at once, and it is what the value rules read.
     */
    formulas?: Array<Array<string | number | boolean | null>>;
    policy?: Policy;
    contract?: SheetContract;
    /** Writes recorded by this process, already filtered to this spreadsheet. */
    writes?: WriteRecord[];
}
export interface LintRule {
    id: string;
    /** The severity this rule reports at, matching `references/lint-rules.md`. */
    severity: LintSeverity;
    /** One line, for the tool's list of what it ran. */
    title: string;
    run(ctx: SheetLintContext): LintFinding[];
}
/**
 * "Roster!A1:J1", quoting the tab only when it needs it.
 *
 * A quoted name is always correct and always uglier, and these strings are read
 * by a person as often as they are pasted, so the quotes go on only when a bare
 * name would not parse.
 */
export declare function lintLocation(title: string, range?: string): string;
/** Zero based row and column to A1: (13, 3) -> "D14". */
export declare function cellA1(row: number, column: number): string;
/** Zero based half open bounds to A1: rows 0..1, cols 0..10 -> "A1:J1". */
export declare function boundsA1(startRow: number, endRow: number, startColumn: number, endColumn: number): string;
/** A GridRange to A1 within its own tab, tolerating the open ended form. */
export declare function gridRangeA1(range: GridRangeLike | null | undefined): string;
export interface AbsoluteCell {
    row: number;
    column: number;
    cell: LintCell;
}
/**
 * Walk every cell the response actually carried, in absolute sheet coordinates.
 * `data` blocks are sparse and each one states where it starts, so the offsets
 * matter: getting them wrong reports the right problem at the wrong address,
 * which is worse than not reporting it.
 */
export declare function eachCell(sheet: LintSheet, visit: (cell: AbsoluteCell) => void): void;
/** One cell out of the sparse blocks, or undefined when the read skipped it. */
export declare function cellAt(sheet: LintSheet, row: number, column: number): LintCell | undefined;
/** The text a person would see in a cell, from whichever field carried it. */
export declare function cellText(cell: LintCell | undefined): string;
/** True when the cell holds a formula rather than a typed value. */
export declare function isFormulaCell(cell: LintCell | undefined): boolean;
export declare function frozenRowCount(sheet: LintSheet): number;
/**
 * The grid the value rules read: FORMULA rendered values when the call carried
 * them, otherwise whatever text the masked read happened to include.
 */
export declare function valueGrid(ctx: SheetLintContext): string[][];
export declare function gridValue(grid: string[][], row: number, column: number): string;
/**
 * Which row holds the headers, zero based.
 *
 * In order of confidence: the contract says so, the tab has a native Table and
 * its range starts there, the frozen rows say so, the first row is bold, or the
 * first row that reads like words rather than numbers. Undefined when no row
 * looks like a header at all, which is a real answer for a scratch tab.
 */
export declare function headerRowIndex(ctx: SheetLintContext): number | undefined;
/** True when the first row is bold across the cells that carry anything. */
export declare function firstRowIsBold(sheet: LintSheet): boolean;
export interface DataRegion {
    /** Zero based, inclusive. */
    headerRow?: number;
    firstDataRow: number;
    lastDataRow: number;
    firstColumn: number;
    lastColumn: number;
    empty: boolean;
}
/**
 * The block of the tab that holds data: from the header row down to the last
 * row carrying anything, across the columns that carry anything.
 *
 * This is what "in a data region" means for the merge rule. A merged title sat
 * above the header row is outside it, which is exactly the arrangement the fix
 * string recommends, so the rule has to be able to tell the two apart.
 */
export declare function dataRegion(ctx: SheetLintContext): DataRegion;
/** Half open row and column bounds overlap. */
export declare function rangesOverlap(a: GridRangeLike, b: GridRangeLike): boolean;
/** Which column a contract role sits on, by letter. */
export declare function columnsWithRole(contract: SheetContract | undefined, role: string): Array<{
    index: number;
    letter: string;
    header?: string;
}>;
//# sourceMappingURL=types.d.ts.map