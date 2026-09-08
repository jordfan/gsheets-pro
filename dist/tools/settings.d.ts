/**
 * `sheets_settings`: the assumptions block, and named ranges.
 *
 * A number typed into the middle of a formula is invisible. The convention a
 * careful person follows is to lift every assumption into a block near the top,
 * one row each, with the value in its own cell and a note saying where the
 * number came from, and then to name that cell so the formulas downstream read
 * `Fee_per_session * Sessions` rather than `$B$4 * D2`.
 *
 * That is the whole tool: write the block, name every value cell, mark the
 * value column as the place a human types, and put a warning only protection
 * over the structure so nobody rearranges it by accident. Named ranges can also
 * be added, repointed and deleted on their own, because they are useful
 * everywhere and not only inside a settings block.
 */
import { z } from "zod";
import type { ToolDefinition, ToolDeps } from "./types.js";
export declare const settingsInputSchema: {
    spreadsheet_id: z.ZodString;
    action: z.ZodOptional<z.ZodEnum<{
        block: "block";
        add_named_range: "add_named_range";
        update_named_range: "update_named_range";
        delete_named_range: "delete_named_range";
        list_named_ranges: "list_named_ranges";
    }>>;
    sheet: z.ZodOptional<z.ZodString>;
    at: z.ZodOptional<z.ZodString>;
    title: z.ZodOptional<z.ZodString>;
    items: z.ZodOptional<z.ZodArray<z.ZodObject<{
        label: z.ZodString;
        value: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>;
        unit: z.ZodOptional<z.ZodString>;
        source: z.ZodOptional<z.ZodString>;
        format: z.ZodOptional<z.ZodEnum<{
            date: "date";
            text: "text";
            currency: "currency";
            percent: "percent";
            integer: "integer";
            decimal: "decimal";
            multiple: "multiple";
        }>>;
        name: z.ZodOptional<z.ZodString>;
        named: z.ZodOptional<z.ZodBoolean>;
        note: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    name: z.ZodOptional<z.ZodString>;
    new_name: z.ZodOptional<z.ZodString>;
    range: z.ZodOptional<z.ZodString>;
    preset: z.ZodOptional<z.ZodString>;
    protect: z.ZodOptional<z.ZodBoolean>;
    tab_color: z.ZodOptional<z.ZodBoolean>;
    dry_run: z.ZodOptional<z.ZodBoolean>;
    force: z.ZodOptional<z.ZodBoolean>;
};
export declare function createSettingsTool(deps: ToolDeps): ToolDefinition<typeof settingsInputSchema>;
/**
 * A date as Sheets stores it: days since 1899-12-30. Written as a number so a
 * date formatted cell really is a date and can be compared and sorted, rather
 * than a string that merely looks like one.
 */
export declare function dateSerial(text: string): number | undefined;
//# sourceMappingURL=settings.d.ts.map