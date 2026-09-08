/**
 * `sheets_batch`: the escape hatch.
 *
 * The named tools cover what people do most days. The Sheets API has sixty-nine
 * request types, and the ones left over (charts, slicers, pivot tables, filter
 * views, cut and paste, text to columns) are real work that somebody will need
 * on a Tuesday. A plugin without an escape hatch turns that Tuesday into a
 * feature request.
 *
 * Two things make the hatch worth using rather than reaching for a raw HTTP
 * call. First, it speaks the same language as everything else: sheet names and
 * A1 anywhere a numeric sheet id or a half open GridRange belongs, resolved
 * server side, because nobody types `endColumnIndex` correctly by hand. Second,
 * `dry_run` shows the resolved plan before anything is sent, which is the only
 * cheap way to find out that a field wanted a DimensionRange and got a
 * GridRange.
 *
 * What it does not do is the point of the reminder in its response. The named
 * tools refuse to overwrite a formula, refuse to write outside the columns the
 * registry reserves, refuse to rewrite a dropdown a person coloured by hand,
 * and refuse to reorder rows on a sheet whose row numbers are written down
 * elsewhere. None of that runs here. On a spreadsheet the registry marks as
 * belonging to a human or shared with one, the response says so plainly.
 */
import { z } from "zod";
import type { ToolDefinition, ToolDeps } from "./types.js";
/** One batchUpdate is atomic, and a very long one is hard to read back. */
export declare const MAX_REQUESTS = 100;
export declare const batchInputSchema: {
    spreadsheet_id: z.ZodString;
    requests: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    sheet: z.ZodOptional<z.ZodString>;
    dry_run: z.ZodOptional<z.ZodBoolean>;
    force: z.ZodOptional<z.ZodBoolean>;
    check: z.ZodOptional<z.ZodBoolean>;
};
export declare function createBatchTool(deps: ToolDeps): ToolDefinition<typeof batchInputSchema>;
//# sourceMappingURL=batch.d.ts.map