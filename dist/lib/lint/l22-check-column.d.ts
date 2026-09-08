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
import { type LintRule } from "./types.js";
/** How many flagged rows one finding quotes before it counts the rest. */
export declare const MAX_CHECK_ROWS_NAMED = 8;
export declare const l22CheckColumn: LintRule;
//# sourceMappingURL=l22-check-column.d.ts.map