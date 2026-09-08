/**
 * `sheets_structure`: the shape of the workbook, as opposed to what is in it.
 *
 * Tabs, rows, columns, sort order, grouping, and protection are one tool
 * because they are one job. A person reorganising a spreadsheet renames a tab,
 * moves a column, sorts the data and freezes the header in one sitting, and
 * splitting that across nine tools makes the model pick between nine
 * near-identical descriptions every time.
 *
 * Three rules make a single wide tool safe.
 *
 * Destructive actions need `confirm` set to the tab's own name. Typing the name
 * is a small tax on a deliberate delete and an effective stop on an accidental
 * one, and unlike a boolean it cannot be satisfied by pattern matching.
 *
 * On a sheet the registry marks `positional_rows`, every action that moves rows
 * is a refusal with a reason, not a warning. Those are the sheets where a row
 * number is written down somewhere else: in an email, in a script, in a
 * colleague's notes. Sorting one silently invalidates all of it.
 *
 * Anything that shifts rows or columns says so in its response. References
 * inside the spreadsheet follow a move on their own; text references,
 * IMPORTRANGE from another file, and anything outside Sheets that keys on a row
 * number do not, and nobody remembers that at the moment they run the call.
 */
import { z } from "zod";
import type { ToolDefinition, ToolDeps } from "./types.js";
export declare const STRUCTURE_ACTIONS: readonly ["add_tab", "rename_tab", "duplicate_tab", "move_tab", "hide_tab", "show_tab", "delete_tab", "copy_tab_to", "insert_rows", "insert_columns", "delete_rows", "delete_columns", "move_rows", "move_columns", "sort", "find_replace", "dedupe", "trim", "group", "ungroup", "protect", "unprotect"];
export type StructureAction = (typeof STRUCTURE_ACTIONS)[number];
/** Actions that destroy something a person cannot get back with undo from here. */
export declare const DESTRUCTIVE_ACTIONS: readonly StructureAction[];
/** Actions refused outright on a registry sheet marked `positional_rows`. */
export declare const ROW_ORDER_ACTIONS: readonly StructureAction[];
export declare const structureInputSchema: {
    spreadsheet_id: z.ZodString;
    action: z.ZodEnum<{
        sort: "sort";
        trim: "trim";
        protect: "protect";
        add_tab: "add_tab";
        rename_tab: "rename_tab";
        duplicate_tab: "duplicate_tab";
        move_tab: "move_tab";
        hide_tab: "hide_tab";
        show_tab: "show_tab";
        delete_tab: "delete_tab";
        copy_tab_to: "copy_tab_to";
        insert_rows: "insert_rows";
        insert_columns: "insert_columns";
        delete_rows: "delete_rows";
        delete_columns: "delete_columns";
        move_rows: "move_rows";
        move_columns: "move_columns";
        find_replace: "find_replace";
        dedupe: "dedupe";
        group: "group";
        ungroup: "ungroup";
        unprotect: "unprotect";
    }>;
    sheet: z.ZodOptional<z.ZodString>;
    title: z.ZodOptional<z.ZodString>;
    index: z.ZodOptional<z.ZodNumber>;
    range: z.ZodOptional<z.ZodString>;
    rows: z.ZodOptional<z.ZodString>;
    columns: z.ZodOptional<z.ZodString>;
    to: z.ZodOptional<z.ZodString>;
    sort_by: z.ZodOptional<z.ZodArray<z.ZodObject<{
        column: z.ZodString;
        order: z.ZodOptional<z.ZodEnum<{
            asc: "asc";
            desc: "desc";
        }>>;
    }, z.core.$strip>>>;
    find: z.ZodOptional<z.ZodString>;
    replace: z.ZodOptional<z.ZodString>;
    match_case: z.ZodOptional<z.ZodBoolean>;
    whole_cell: z.ZodOptional<z.ZodBoolean>;
    regex: z.ZodOptional<z.ZodBoolean>;
    include_formulas: z.ZodOptional<z.ZodBoolean>;
    key_columns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    description: z.ZodOptional<z.ZodString>;
    warning_only: z.ZodOptional<z.ZodBoolean>;
    collapsed: z.ZodOptional<z.ZodBoolean>;
    destination_spreadsheet_id: z.ZodOptional<z.ZodString>;
    confirm: z.ZodOptional<z.ZodString>;
    force: z.ZodOptional<z.ZodBoolean>;
};
export declare function createStructureTool(deps: ToolDeps): ToolDefinition<typeof structureInputSchema>;
//# sourceMappingURL=structure.d.ts.map