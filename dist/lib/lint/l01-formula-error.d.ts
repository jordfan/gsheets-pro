/**
 * L01, formula error: a cell whose evaluated value is an `errorValue`.
 *
 * This is the one rule that is never a matter of taste. A `#REF!` is the
 * spreadsheet saying it cannot answer, and every cell downstream of it inherits
 * the failure, so one broken reference near the top of a column produces forty
 * findings that are all the same finding. The rule reports each cell because a
 * person needs the addresses, and the tool's `error_summary` counts them by
 * type so the shape of the failure is visible at a glance.
 *
 * `LOADING` is not an error and never becomes one here. It means a volatile
 * function has not finished, which is Sheets working. The tool retries for a
 * few seconds and then reports `pending`; this rule only ever counts it.
 */
import { type LintRule, type SheetLintContext } from "./types.js";
/** How many error cells become findings before the rest are summarised. */
export declare const MAX_ERROR_FINDINGS = 25;
export interface FormulaErrorCell {
    location: string;
    /** The `ErrorValue.type` enum value, which is locale independent. */
    type: string;
    message?: string;
}
export interface FormulaErrorTally {
    totalFormulas: number;
    errors: FormulaErrorCell[];
    /** Cells still calculating. Counted, never reported as an error. */
    loading: number;
}
/**
 * Count formulas and collect error cells. Exported on its own because
 * `sheets_check` needs the counts for its recalculation shaped summary whether
 * or not L01 is one of the selected rules.
 */
export declare function tallyFormulaErrors(ctx: SheetLintContext): FormulaErrorTally;
export declare const l01FormulaError: LintRule;
//# sourceMappingURL=l01-formula-error.d.ts.map