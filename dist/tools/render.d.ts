/**
 * `sheets_render`: look at the sheet.
 *
 * The lint can tell you a formula is broken. It cannot tell you the guardian
 * email column is forty pixels too narrow, that a status fill is unreadable
 * against its own text, or that a row wrapped to three lines and made the table
 * look like a mistake. Those are the things a person notices in half a second
 * and a model never notices at all, unless it is handed the picture.
 *
 * The response is a file path locally and a short lived signed URL when hosted.
 * Never image bytes: MCP image content blocks are mishandled by Claude Code, so
 * a render that returned them would be a render nobody could see.
 *
 * Every response says the same thing about what a picture cannot show. No
 * dropdown paints as a pill, and one the API created is plain black text that
 * looks exactly like a cell with no rule at all, so a bare-looking cell is not
 * evidence that a validation rule is missing and `sheets_check` is the
 * authority on that. The near miss is worth knowing and is in the caveat too: a
 * rule somebody coloured by hand does paint as coloured text, which makes a
 * render the only way to see that those colours are still there.
 */
import { z } from "zod";
import { type ExportUrlOptions } from "../lib/render.js";
import type { ToolDefinition, ToolDeps } from "./types.js";
/** What a render can never show, said the same way every time. */
export declare const RENDER_CAVEAT = "No dropdown paints as a pill. A rule the API created shows as plain black text, indistinguishable from a cell carrying no rule at all, so a bare-looking cell here is not evidence that a rule is missing and sheets_check is authoritative for validation state. The one thing the image does show is colour: a rule somebody coloured by hand in the Sheets UI paints as coloured text, so a column of dropdowns that has gone plain black has lost those colours, which no API call can put back. Everything else in the image is trustworthy: fills, fonts, borders, banding, merges, column widths, and conditional formats all paint, and the frozen header repeats on every page.";
export declare const renderInputSchema: {
    spreadsheet_id: z.ZodString;
    sheet: z.ZodString;
    range: z.ZodOptional<z.ZodString>;
    dpi: z.ZodOptional<z.ZodNumber>;
    gridlines: z.ZodOptional<z.ZodBoolean>;
    portrait: z.ZodOptional<z.ZodBoolean>;
    max_pages: z.ZodOptional<z.ZodNumber>;
};
export interface RenderToolOptions {
    /** Injectable for tests, so the pipeline can be exercised without Google. */
    fetchImpl?: typeof fetch;
    /** Injectable for tests, so the pipeline can be exercised without poppler. */
    runPdftoppm?: (file: string, args: string[]) => Promise<void>;
}
export declare function createRenderTool(deps: ToolDeps, toolOptions?: RenderToolOptions): ToolDefinition<typeof renderInputSchema>;
/** A1 to the export URL's zero based, end exclusive range parameters. */
export declare function rangeParams(range: string): Pick<ExportUrlOptions, "r1" | "c1" | "r2" | "c2">;
//# sourceMappingURL=render.d.ts.map