/**
 * Number formats.
 *
 * The Sheets API rejects a pattern whose declared type does not match it, so a
 * literal pattern gets its type inferred from the tokens Sheets itself uses.
 * Shorthands exist because "currency" is what a person means and
 * '"$"#,##0.00' is what the API wants.
 */
export interface NumberFormat {
    type: string;
    pattern: string;
}
export declare const NUMBER_FORMAT_SHORTHANDS: string[];
/**
 * Turn either a shorthand name or a literal pattern into a NumberFormat.
 */
export declare function resolveNumberFormat(spec: string): NumberFormat;
/**
 * The reverse, for describing a sheet we just read: name the shorthand when a
 * format matches one, so `sheets_open` can report "currency" rather than a
 * pattern the reader has to decode.
 */
export declare function describeNumberFormat(format: {
    type?: string | null;
    pattern?: string | null;
} | null | undefined): string | undefined;
//# sourceMappingURL=numfmt.d.ts.map