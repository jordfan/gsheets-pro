/**
 * L20, the key column is blank or duplicated.
 *
 * Every keyed update depends on one column identifying one row. A blank in it
 * means a row that no update can ever reach; a duplicate means an update that
 * silently picks one of two rows, and which one it picks depends on read order.
 * Both are quiet until the day somebody's record does not change and nobody can
 * work out why.
 *
 * The rule only runs when the contract names a key column, either through the
 * sheet's own metadata or through a column whose role is `key`. Inference is
 * not enough: guessing which column is the key and then complaining about it is
 * how a lint earns a reputation for being wrong.
 */
import { type LintRule } from "./types.js";
/** How many offending rows one finding names before it summarises. */
export declare const MAX_KEY_ROWS_NAMED = 10;
export declare const l20KeyColumn: LintRule;
//# sourceMappingURL=l20-key-column.d.ts.map