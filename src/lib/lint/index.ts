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

import { l01FormulaError, tallyFormulaErrors, type FormulaErrorTally } from "./l01-formula-error.js";
import { l04MergeInData } from "./l04-merge-in-data.js";
import { l09FrozenHeader } from "./l09-frozen-header.js";
import { l14WriteOutsideColumns } from "./l14-write-outside-columns.js";
import { l20KeyColumn } from "./l20-key-column.js";
import { l22CheckColumn } from "./l22-check-column.js";
import { l23ColleagueText } from "./l23-colleague-text.js";
import type { LintFinding, LintRule, LintSeverity, SheetLintContext } from "./types.js";

export const LINT_RULES: readonly LintRule[] = [
  l01FormulaError,
  l04MergeInData,
  l09FrozenHeader,
  l14WriteOutsideColumns,
  l20KeyColumn,
  l22CheckColumn,
  l23ColleagueText,
];

export const LINT_RULE_IDS: readonly string[] = LINT_RULES.map((rule) => rule.id);

export function ruleById(id: string): LintRule | undefined {
  const wanted = String(id ?? "").trim().toUpperCase();
  return LINT_RULES.find((rule) => rule.id === wanted);
}

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
export function runRules(ctx: SheetLintContext, options: RunRulesOptions = {}): RunRulesResult {
  const { rules, unknown } = selectRules(options.rules);
  const findings: LintFinding[] = [];
  for (const rule of rules) {
    findings.push(...rule.run(ctx));
  }
  return { findings, ran: rules.map((rule) => rule.id), unknown };
}

export function selectRules(ids?: string[]): { rules: LintRule[]; unknown: string[] } {
  if (!ids || ids.length === 0) return { rules: [...LINT_RULES], unknown: [] };
  const rules: LintRule[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    const rule = ruleById(id);
    if (rule) {
      if (!rules.includes(rule)) rules.push(rule);
    } else {
      unknown.push(String(id));
    }
  }
  // Keep the catalogue's order rather than the caller's, so two calls that ask
  // for the same rules read the same way.
  rules.sort((a, b) => LINT_RULES.indexOf(a) - LINT_RULES.indexOf(b));
  return { rules, unknown };
}

/** Count findings by severity, for the one line summary. */
export function countBySeverity(findings: LintFinding[]): Record<LintSeverity, number> {
  const counts: Record<LintSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

export { tallyFormulaErrors };
export type { FormulaErrorTally };
export * from "./types.js";
