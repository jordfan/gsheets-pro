/**
 * `sheets_open`: the first call of every session.
 *
 * Opening a spreadsheet blind is how agents wreck them. This tool answers, in
 * one round trip, the questions that should be settled before anything is
 * written: what the tabs are, which ones are native Tables, where the named
 * ranges and protections sit, what contract governs writes, which dropdowns
 * belong to the UI, and what conventions the sheet already follows.
 *
 * It is deliberately loud about not knowing. A spreadsheet with no registry
 * entry and no plugin metadata gets "no contract" rather than a guess, because
 * a confident guess about who owns a column is worse than an admission.
 */
import { z } from "zod";
import type { ToolDefinition, ToolDeps } from "./types.js";
export declare const openInputSchema: {
    spreadsheet_id: z.ZodOptional<z.ZodString>;
    sheet: z.ZodOptional<z.ZodString>;
    create: z.ZodOptional<z.ZodObject<{
        title: z.ZodString;
        tabs: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    include_validation: z.ZodOptional<z.ZodBoolean>;
    sample_rows: z.ZodOptional<z.ZodNumber>;
};
export declare function createOpenTool(deps: ToolDeps): ToolDefinition<typeof openInputSchema>;
//# sourceMappingURL=open.d.ts.map