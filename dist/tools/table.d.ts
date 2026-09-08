/**
 * `sheets_table`: native Tables, created, adopted, updated and deleted.
 *
 * A native Table is the closest thing Sheets has to saying "this block is one
 * thing": it types its columns, bands its rows, keeps its own range as data is
 * added, and gives every column a name that formulas can use. It is also the
 * feature most likely to destroy data if used naively, so three findings from
 * spike 3 are enforced here rather than left to the caller.
 *
 * `footerColorStyle` is never sent. It reads like a colour and behaves like a
 * command: it converts the Table's last data row into a footer and overwrites
 * that row's cells with SUM formulas, silently. A totals row has to be asked
 * for explicitly, and this tool does not offer one.
 *
 * A Table's DROPDOWN column carries its rule on the Table, not on its cells, so
 * this tool is the only way to change one, and it refuses to rewrite a rule the
 * plugin did not create. Spike 4 measured what a rewrite costs: an identical
 * condition, re-applied, wiped the chip colours a person had set by hand, and
 * the API reported success. Those colours are not readable in either direction,
 * so nothing could have saved them first.
 *
 * `adopt` writes metadata and notes and nothing else. Adopting is what happens
 * to somebody else's sheet, and the polite version of that is to record what
 * the columns mean without repainting anything.
 */
import { z } from "zod";
import type { ToolDefinition, ToolDeps } from "./types.js";
export declare const tableInputSchema: {
    spreadsheet_id: z.ZodString;
    sheet: z.ZodString;
    action: z.ZodEnum<{
        update: "update";
        delete: "delete";
        create: "create";
        adopt: "adopt";
    }>;
    name: z.ZodOptional<z.ZodString>;
    range: z.ZodOptional<z.ZodString>;
    columns: z.ZodOptional<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        type: z.ZodOptional<z.ZodEnum<{
            TEXT: "TEXT";
            BOOLEAN: "BOOLEAN";
            CURRENCY: "CURRENCY";
            PERCENT: "PERCENT";
            DATE: "DATE";
            DATE_TIME: "DATE_TIME";
            TIME: "TIME";
            DOUBLE: "DOUBLE";
            DROPDOWN: "DROPDOWN";
            FILES_CHIP: "FILES_CHIP";
            PEOPLE_CHIP: "PEOPLE_CHIP";
            FINANCE_CHIP: "FINANCE_CHIP";
            PLACE_CHIP: "PLACE_CHIP";
            RATINGS_CHIP: "RATINGS_CHIP";
        }>>;
        options: z.ZodOptional<z.ZodArray<z.ZodString>>;
        options_range: z.ZodOptional<z.ZodString>;
        note: z.ZodOptional<z.ZodString>;
        role: z.ZodOptional<z.ZodEnum<{
            [x: string]: string;
        }>>;
        owner: z.ZodOptional<z.ZodEnum<{
            human: "human";
            shared: "shared";
            agent: "agent";
        }>>;
        key: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    preset: z.ZodOptional<z.ZodString>;
    freeze_header: z.ZodOptional<z.ZodBoolean>;
    filter: z.ZodOptional<z.ZodBoolean>;
    protect_header: z.ZodOptional<z.ZodBoolean>;
    status_fill_rules: z.ZodOptional<z.ZodBoolean>;
    status_column: z.ZodOptional<z.ZodString>;
    status_colors: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodEnum<{
        ok: "ok";
        warn: "warn";
        flag: "flag";
        muted: "muted";
    }>>>;
    confirm: z.ZodOptional<z.ZodString>;
    force: z.ZodOptional<z.ZodBoolean>;
    dry_run: z.ZodOptional<z.ZodBoolean>;
};
export declare function createTableTool(deps: ToolDeps): ToolDefinition<typeof tableInputSchema>;
//# sourceMappingURL=table.d.ts.map