/**
 * A1 notation, GridRange conversion, and column/row spans.
 *
 * Pure and dependency free so every case can be tested offline. The Sheets API
 * speaks numeric sheet ids and half open GridRanges; humans speak tab names and
 * A1. Everything in the tool surface is the human form, and this file is the
 * translation layer.
 */
export interface GridRange {
    sheetId: number;
    startRowIndex?: number;
    endRowIndex?: number;
    startColumnIndex?: number;
    endColumnIndex?: number;
}
/** A GridRange without the sheet, which is all A1 alone can describe. */
export type RangeBounds = Omit<GridRange, "sheetId">;
/**
 * The same bounds as the Google client hands them back: absent OR null. Read
 * helpers take this shape so a Schema$GridRange can be passed straight in.
 */
export interface NullableBounds {
    startRowIndex?: number | null;
    endRowIndex?: number | null;
    startColumnIndex?: number | null;
    endColumnIndex?: number | null;
}
export interface Span {
    startIndex: number;
    endIndex: number;
}
/** "A" -> 0, "Z" -> 25, "AA" -> 26. Throws on anything else. */
export declare function columnLetterToIndex(letters: string): number;
/** 0 -> "A", 26 -> "AA". */
export declare function columnIndexToLetter(index: number): string;
export interface SplitRange {
    /** The tab name, unquoted and unescaped, or undefined when the range had none. */
    sheet?: string;
    /** The A1 body, which may be empty when the reference was a bare tab name. */
    range: string;
}
/**
 * Split "'My Sheet'!A1:B2" into its tab name and its A1 body.
 *
 * Quoted names are the hard case: a tab may legitimately contain "!" or ":",
 * and Sheets escapes an apostrophe inside a quoted name by doubling it. So a
 * quoted qualifier is scanned character by character rather than searched for
 * the last "!", which is what a naive split gets wrong on 'Q1!Draft'!A1.
 */
export declare function splitSheetRange(input: string): SplitRange;
/** Strip a leading sheet qualifier: "'My Sheet'!A1:B2" -> "A1:B2". */
export declare function stripSheetPrefix(range: string): string;
/** Quote a tab name for use in an A1 range: My Sheet -> 'My Sheet'. */
export declare function quoteSheetName(name: string): string;
/** Build a fully qualified A1 reference: ("My Sheet", "A1:C10") -> "'My Sheet'!A1:C10". */
export declare function toA1Reference(sheet: string, range?: string): string;
/**
 * Convert A1 notation to the row/column half of a GridRange.
 *
 * Bounds are half open the way the Sheets API wants them, and an axis the
 * notation leaves open (the rows of "B:B", the columns of "3:3") is simply
 * absent, which the API reads as "the whole sheet on that axis".
 */
export declare function parseA1(range: string): RangeBounds;
/** parseA1 plus a sheetId. An absent or empty range means the whole sheet. */
export declare function a1ToGridRange(range: string | undefined | null, sheetId: number): GridRange;
/** Render a GridRange back to A1 for human readable output. */
export declare function gridRangeToA1(range: NullableBounds): string;
/** How many cells a range covers, or undefined when an axis is unbounded. */
export declare function rangeCellCount(range: NullableBounds): number | undefined;
/**
 * The smallest range covering both inputs, used to build the one masked read
 * that closes a write. Two ranges on different sheets cannot be merged.
 */
export declare function unionBounds(a: NullableBounds, b: NullableBounds): RangeBounds;
/** "A" -> 0..1, "B:D" -> 1..4. */
export declare function parseColumnSpan(spec: string): Span;
/** "1" -> 0..1, "2:5" -> 1..5. */
export declare function parseRowSpan(spec: string): Span;
/** "1 request" / "3 requests". */
export declare function pluralize(count: number, singular: string, plural?: string): string;
//# sourceMappingURL=a1.d.ts.map