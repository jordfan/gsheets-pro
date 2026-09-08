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
import { cellA1, eachCell, lintLocation, } from "./types.js";
/** How many error cells become findings before the rest are summarised. */
export const MAX_ERROR_FINDINGS = 25;
/**
 * Count formulas and collect error cells. Exported on its own because
 * `sheets_check` needs the counts for its recalculation shaped summary whether
 * or not L01 is one of the selected rules.
 */
export function tallyFormulaErrors(ctx) {
    const tally = { totalFormulas: 0, errors: [], loading: 0 };
    eachCell(ctx.sheet, ({ row, column, cell }) => {
        if (typeof cell.userEnteredValue?.formulaValue === "string")
            tally.totalFormulas += 1;
        const error = cell.effectiveValue?.errorValue;
        const type = error?.type;
        if (!type)
            return;
        if (type === "LOADING") {
            tally.loading += 1;
            return;
        }
        const entry = {
            location: lintLocation(ctx.title, cellA1(row, column)),
            type,
        };
        if (error?.message)
            entry.message = error.message;
        tally.errors.push(entry);
    });
    // The masked read is the authority on errors, but it only carries the cells
    // the call asked for. Where the FORMULA render is the wider of the two, its
    // formula count is the honest one.
    if (ctx.formulas) {
        let counted = 0;
        for (const row of ctx.formulas) {
            for (const value of row ?? []) {
                if (typeof value === "string" && value.startsWith("="))
                    counted += 1;
            }
        }
        if (counted > tally.totalFormulas)
            tally.totalFormulas = counted;
    }
    return tally;
}
export const l01FormulaError = {
    id: "L01",
    severity: "error",
    title: "A cell evaluates to an error",
    run(ctx) {
        const { errors } = tallyFormulaErrors(ctx);
        const shown = errors.slice(0, MAX_ERROR_FINDINGS);
        const findings = shown.map((cell) => ({
            rule: "L01",
            severity: "error",
            location: cell.location,
            message: cell.message
                ? `${cell.location} evaluates to ${errorName(cell.type)}. ${cell.message}`
                : `${cell.location} evaluates to ${errorName(cell.type)}.`,
            fix: `sheets_read with values: "formulas" over ${cell.location} to see what the formula points at, then repair the reference. Read the first cell that broke rather than the last: everything downstream inherits it.`,
        }));
        if (errors.length > shown.length) {
            const rest = errors.length - shown.length;
            findings.push({
                rule: "L01",
                severity: "error",
                location: lintLocation(ctx.title),
                message: `And ${rest} more cell(s) on ${ctx.title} carrying the same kind of error. They are counted in error_summary.`,
                fix: "Fix the first broken cell in each column and re-run sheets_check. A cascade usually collapses to one or two real causes.",
            });
        }
        return findings;
    },
};
/** "#REF!" reads better than "REF" in a sentence a person has to act on. */
function errorName(type) {
    switch (type) {
        case "REF":
            return "#REF!";
        case "NAME":
            return "#NAME?";
        case "VALUE":
            return "#VALUE!";
        case "DIVIDE_BY_ZERO":
            return "#DIV/0!";
        case "NUM":
            return "#NUM!";
        case "N_A":
            return "#N/A";
        case "NULL_VALUE":
            return "#NULL!";
        case "ERROR":
            return "#ERROR!";
        default:
            return type;
    }
}
//# sourceMappingURL=l01-formula-error.js.map