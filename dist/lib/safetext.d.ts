/**
 * Text in a shared spreadsheet reads as a colleague wrote it.
 *
 * Somebody opens a shared sheet with no idea an agent touched it. A cell
 * reading "TODO: confirm per 18f2a1c9b4d0e77a" or "agent run 2026-09-07T03:00"
 * tells them nothing and makes the sheet look like a log file. So every string
 * a write puts into a spreadsheet whose owner is a person, or which the
 * registry marks as shared, goes past this first.
 *
 * The rules match on patterns, not on bare words. A spreadsheet tracking
 * software work will legitimately contain "agent", and a recruiting sheet will
 * legitimately contain "TODO" in a column of its own. Matching the bare word
 * would make the check something people turn off, and a check that gets turned
 * off protects nothing. Each pattern here needs a shape that a colleague would
 * not have typed, and a sheet can carry its own allowlist in the registry.
 *
 * Two severities. `refuse` blocks the write and names the cell, because the
 * pattern is unambiguous. `warn` is reported and written, because the pattern
 * is a heuristic and a false positive would be worse than the miss.
 */
export type SafeTextSeverity = "refuse" | "warn";
export interface SafeTextRule {
    id: string;
    severity: SafeTextSeverity;
    pattern: RegExp;
    /** What a colleague would have written instead. */
    fix: string;
    /** Only applied when the whole cell matches, not to a substring. */
    wholeCellOnly?: boolean;
}
/**
 * Every rule is anchored on a shape rather than a vocabulary word.
 */
export declare const SAFE_TEXT_RULES: readonly SafeTextRule[];
export interface SafeTextFinding {
    /** Where the string was going, for example "Tracker!D14". */
    location: string;
    rule: string;
    severity: SafeTextSeverity;
    /** The exact text that matched, so the fix is unambiguous. */
    matched: string;
    value: string;
    fix: string;
}
export interface SafeTextOptions {
    /** Phrases legitimate on this sheet, from the registry entry. */
    allowlist?: string[];
}
/** Check one string. Pure, so the lint and the write gate share it. */
export declare function checkText(value: unknown, location: string, options?: SafeTextOptions): SafeTextFinding[];
export interface SafeTextTarget {
    location: string;
    value: unknown;
}
/** Check a batch of cells, returning findings in the order they were given. */
export declare function checkTexts(targets: SafeTextTarget[], options?: SafeTextOptions): SafeTextFinding[];
/** True when this sheet's text is read by people other than whoever wrote it. */
export declare function colleagueSafeApplies(policy: {
    owner?: string;
    colleagueSafeText?: boolean;
} | undefined): boolean;
/** One sentence naming what has to change, for a refusal message. */
export declare function describeFindings(findings: SafeTextFinding[], limit?: number): string;
//# sourceMappingURL=safetext.d.ts.map