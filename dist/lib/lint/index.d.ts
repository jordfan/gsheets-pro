/**
 * The rule set, and the loop that runs it.
 *
 * Seven rules ship in v1. Each one is unambiguous, cheap to compute from the
 * two reads `sheets_check` already makes, and produces a fix that names a
 * specific call. The rest of the catalogue in `references/style-guide.md` is
 * still the standard; it is just not machine checked yet, and a rule that
 * cannot be checked without guessing is a rule that would cry wolf.
 *
 * Order matters only for reading: findings come back grouped by tab, and within
 * a tab in the order of this list, which puts errors before warnings without
 * anybody having to sort.
 */
import { tallyFormulaErrors, type FormulaErrorTally } from "./l01-formula-error.js";
import type { LintFinding, LintRule, LintSeverity, SheetLintContext } from "./types.js";
export declare const LINT_RULES: readonly LintRule[];
export declare const LINT_RULE_IDS: readonly string[];
export declare function ruleById(id: string): LintRule | undefined;
export interface RunRulesOptions {
    /** Run only these rule ids. Unknown ids are reported rather than ignored. */
    rules?: string[];
}
export interface RunRulesResult {
    findings: LintFinding[];
    /** Which rules actually ran, in order. */
    ran: string[];
    /** Ids asked for that no rule answers to. */
    unknown: string[];
}
/** Run the selected rules over one tab. Pure: no calls, no clock, no globals. */
export declare function runRules(ctx: SheetLintContext, options?: RunRulesOptions): RunRulesResult;
export declare function selectRules(ids?: string[]): {
    rules: LintRule[];
    unknown: string[];
};
/** Count findings by severity, for the one line summary. */
export declare function countBySeverity(findings: LintFinding[]): Record<LintSeverity, number>;
export { tallyFormulaErrors };
export type { FormulaErrorTally };
export * from "./types.js";
//# sourceMappingURL=index.d.ts.map