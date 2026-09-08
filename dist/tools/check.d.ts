/**
 * `sheets_check`: the lint.
 *
 * The per write error gate answers one question, cheaply, about the cells that
 * write touched. This answers the wider one: is the spreadsheet in a state a
 * careful person would hand to somebody. It reports formula errors the same way
 * a recalculation report does, because a model that has seen one has seen the
 * other, and alongside them the structural findings no picture can show: a
 * merge inside a table, a header that scrolls away, a key column with two
 * identical values, a write that landed in somebody else's column, text that
 * reads as machine output.
 *
 * Two reads, in this order.
 *
 * 1. `values.batchGet` with FORMULA rendering. It comes back trimmed to the
 *    cells that hold anything, which is how the tool learns each tab's real
 *    extent without guessing, and it shows formulas and values at once.
 * 2. A masked `spreadsheets.get` with grid data over exactly those extents.
 *    Errors, notes, validation, bold, merges, tables and frozen rows all live
 *    here, and bounding it to the used range is the difference between a read
 *    that costs a few hundred cells and one that walks a million empty ones.
 *
 * `LOADING` is retried before it counts, the same way the write gate does it,
 * because a volatile function that has not settled is Sheets working rather
 * than a sheet that is broken.
 */
import { z } from "zod";
import type { ToolDefinition, ToolDeps } from "./types.js";
/** How many tabs one call will read in full before it asks to be narrowed. */
export declare const MAX_TABS = 20;
/** Cells the grid read will ask for across every tab. */
export declare const MAX_GRID_CELLS = 60000;
/** Locations named per error type in the summary, per the rule catalogue. */
export declare const MAX_ERROR_LOCATIONS = 100;
export declare const checkInputSchema: {
    spreadsheet_id: z.ZodString;
    sheets: z.ZodOptional<z.ZodArray<z.ZodString>>;
    sheet: z.ZodOptional<z.ZodString>;
    range: z.ZodOptional<z.ZodString>;
    rules: z.ZodOptional<z.ZodArray<z.ZodString>>;
    writes: z.ZodOptional<z.ZodArray<z.ZodString>>;
};
export interface CheckToolOptions {
    /** How long to wait out LOADING before reporting pending. Injectable for tests. */
    loadingBudgetMs?: number;
}
export declare function createCheckTool(deps: ToolDeps, toolOptions?: CheckToolOptions): ToolDefinition<typeof checkInputSchema>;
//# sourceMappingURL=check.d.ts.map