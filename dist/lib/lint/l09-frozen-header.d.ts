/**
 * L09, no frozen header.
 *
 * A tab with a header row and no frozen rows scrolls its own labels off the
 * screen. Everyone who opens it past row 30 is reading a grid of values with no
 * idea which column is which, and the fix is one call that nobody ever regrets.
 *
 * The rule fires on the two cases where a header row is certain rather than
 * guessed: the tab has a native Table, or its first row is bold. A tab whose
 * header was only inferred from the text looking like words is left alone,
 * because a lint that nags about a scratch tab is a lint people switch off.
 */
import { type LintRule } from "./types.js";
export declare const l09FrozenHeader: LintRule;
//# sourceMappingURL=l09-frozen-header.d.ts.map