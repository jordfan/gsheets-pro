/**
 * L04, a merge inside a data region.
 *
 * A merged cell in the middle of a table is the single most expensive piece of
 * decoration in spreadsheets. Sorting refuses to run across it, a filter drops
 * the rows underneath it, and a formula that crosses it reads a blank where a
 * person sees a value. It always looks fine and it always breaks later.
 *
 * What counts as a data region: the header row and everything below it, out to
 * the last column and row carrying anything, plus any native Table's own range.
 * A merged title above the header row is not in the region and is not flagged,
 * because that is the arrangement the fix recommends.
 */
import { type LintRule } from "./types.js";
export declare const l04MergeInData: LintRule;
//# sourceMappingURL=l04-merge-in-data.d.ts.map