/**
 * L14, a write outside the columns that are ours.
 *
 * This rule is about history, not about the sheet as it stands. A value in
 * somebody else's column proves nothing, because they almost certainly typed
 * it. What matters is whether this session put it there, so the rule reads the
 * ledger of ranges the process wrote and asks the contract whether each column
 * was ours.
 *
 * Two sources say a column is not ours, and both are somebody's stated
 * intention rather than a guess: the repo registry's `writable_columns`, and
 * column metadata whose owner is `human`. Inference never feeds this rule. A
 * warning that a write "may have" landed somewhere it should not is exactly the
 * kind of finding that teaches people to skim past findings.
 *
 * The severity is warning rather than error on purpose. By the time the lint
 * runs the write has already happened, and the useful response is to undo it,
 * which the fix string says. Calling it an error would stop a build over
 * something that stopping cannot repair.
 */
import { type LintRule } from "./types.js";
export declare const l14WriteOutsideColumns: LintRule;
//# sourceMappingURL=l14-write-outside-columns.d.ts.map