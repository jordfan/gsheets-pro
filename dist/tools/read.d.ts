/**
 * `sheets_read`: values, formulas, or both.
 *
 * Three choices shape this tool.
 *
 * Records by default. A grid of strings makes the model count columns, and it
 * miscounts. Records keyed by header do not, and every record carries `_row`,
 * the true one based row in the sheet, so a later write lands on the row it
 * meant even after someone sorts the tab.
 *
 * Formulas are first class. `=SUM(B2:B9)` displayed as `312` is a different
 * fact from the number 312, and a tool that only ever shows the number will
 * eventually overwrite a formula with its own stale result.
 *
 * Big reads paginate rather than truncate. A response that silently stops
 * halfway is how an agent concludes a roster has 40 students when it has 90.
 */
import { z } from "zod";
import { type CellValue } from "../lib/records.js";
import type { ToolDefinition, ToolDeps } from "./types.js";
/** Detail reads (format, note, validation) are capped, per the plan. */
export declare const DETAIL_CELL_CAP = 500;
export declare const readInputSchema: {
    spreadsheet_id: z.ZodString;
    sheet: z.ZodOptional<z.ZodString>;
    range: z.ZodOptional<z.ZodString>;
    ranges: z.ZodOptional<z.ZodArray<z.ZodString>>;
    as: z.ZodOptional<z.ZodEnum<{
        records: "records";
        grid: "grid";
    }>>;
    values: z.ZodOptional<z.ZodEnum<{
        raw: "raw";
        formatted: "formatted";
        formulas: "formulas";
        both: "both";
    }>>;
    header_row: z.ZodOptional<z.ZodNumber>;
    columns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    where: z.ZodOptional<z.ZodArray<z.ZodObject<{
        column: z.ZodString;
        op: z.ZodEnum<{
            in: "in";
            eq: "eq";
            ne: "ne";
            contains: "contains";
            not_contains: "not_contains";
            starts_with: "starts_with";
            ends_with: "ends_with";
            gt: "gt";
            gte: "gte";
            lt: "lt";
            lte: "lte";
            blank: "blank";
            not_blank: "not_blank";
        }>;
        value: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>]>>;
    }, z.core.$strip>>>;
    find: z.ZodOptional<z.ZodObject<{
        query: z.ZodString;
        match_case: z.ZodOptional<z.ZodBoolean>;
        whole_cell: z.ZodOptional<z.ZodBoolean>;
        regex: z.ZodOptional<z.ZodBoolean>;
        in_sheets: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    include: z.ZodOptional<z.ZodObject<{
        formats: z.ZodOptional<z.ZodBoolean>;
        notes: z.ZodOptional<z.ZodBoolean>;
        validation: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    limit: z.ZodOptional<z.ZodNumber>;
    offset: z.ZodOptional<z.ZodNumber>;
};
export declare function createReadTool(deps: ToolDeps): ToolDefinition<typeof readInputSchema>;
/**
 * Which row inside the returned block holds the headers, as an offset from the
 * top of the block. Frozen rows are the strongest signal a person leaves; the
 * first all text row is the fallback.
 */
export declare function resolveHeaderOffset(headerRow: number | undefined, originRow: number, frozenRowCount: number | undefined, grid: CellValue[][], asRecords: boolean): number | undefined;
//# sourceMappingURL=read.d.ts.map