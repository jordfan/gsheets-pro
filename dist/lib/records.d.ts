/**
 * Rows as records.
 *
 * A grid of cells is what the API returns and almost never what the caller
 * wants. `[["Ana","3"],["Bo","4"]]` forces the model to remember that column 2
 * is the grade; `{ name: "Ana", grade: "3", _row: 2 }` does not. So reads hand
 * back records keyed by header.
 *
 * Every record carries `_row`, the real one based row number in the sheet. It
 * is the difference between "update Ana's grade" working and quietly writing to
 * the wrong line after someone sorted the tab. Filtering never renumbers it.
 */
export type CellValue = string | number | boolean | null;
export interface SheetRecord {
    /** One based row number in the sheet, always the true position. */
    _row: number;
    [key: string]: CellValue | number;
}
/**
 * Turn header text into stable keys: blanks become their column letter,
 * duplicates get a numeric suffix, so no column is silently lost.
 */
export declare function normalizeHeaders(headers: Array<string | null | undefined>, width?: number): string[];
export interface ToRecordsOptions {
    /** One based sheet row of the first data row. */
    firstDataRow: number;
    /** Drop rows where every cell is empty. Default true. */
    skipBlank?: boolean;
}
/** Zip a grid of values against headers, stamping the true row number on each. */
export declare function toRecords(rows: CellValue[][], headers: string[], options: ToRecordsOptions): SheetRecord[];
export declare const WHERE_OPERATORS: readonly ["eq", "ne", "contains", "not_contains", "starts_with", "ends_with", "gt", "gte", "lt", "lte", "blank", "not_blank", "in"];
export type WhereOperator = (typeof WHERE_OPERATORS)[number];
export interface WhereClause {
    /** A header name or a column letter. */
    column: string;
    op: WhereOperator;
    value?: string | number | boolean | Array<string | number | boolean>;
}
/** Compare one record against one clause. Text compares ignore case. */
export declare function matchesClause(record: SheetRecord, clause: WhereClause, headers: string[]): boolean;
/** All clauses must match, which is what a person means by a filter. */
export declare function applyWhere(records: SheetRecord[], clauses: WhereClause[] | undefined, headers: string[]): SheetRecord[];
export interface FindHit {
    sheet: string;
    /** A1 of the matching cell, without the tab qualifier. */
    cell: string;
    row: number;
    column: string;
    value: string;
    /** The header above the match, when the tab has one. */
    header?: string;
}
export interface FindOptions {
    query: string;
    matchCase?: boolean;
    /** Match the whole cell rather than any part of it. */
    wholeCell?: boolean;
    /** Treat the query as a regular expression. */
    regex?: boolean;
    limit?: number;
}
/** Search one tab's grid. Pure, so `find` across tabs is just a loop. */
export declare function findInGrid(sheet: string, rows: CellValue[][], options: FindOptions, headers?: string[]): FindHit[];
export interface Page<T> {
    items: T[];
    offset: number;
    limit: number;
    total: number;
    /** The offset to pass next, or undefined when this is the last page. */
    nextOffset?: number;
}
export declare function paginate<T>(items: T[], offset?: number, limit?: number): Page<T>;
//# sourceMappingURL=records.d.ts.map