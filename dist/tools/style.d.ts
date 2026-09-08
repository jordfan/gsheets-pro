/**
 * `sheets_style`: how a sheet looks, in one call.
 *
 * Formatting is the thing every other Sheets MCP leaves out, and it is most of
 * what makes a spreadsheet read as a careful person's work. So it is one tool
 * taking one style object over one range, rather than a dozen verb-shaped
 * tools, and everything it does lands in a single `batchUpdate`.
 *
 * Three ideas run through it.
 *
 * **Colors are named, never guessed.** A call says `role: "header"` or
 * `background: "theme:ACCENT1"`. Roles resolve through the preset, and any
 * color that names one of the nine theme slots is written as
 * `ColorStyle.themeColor`, so Format > Theme stays the human's knob and
 * changing the preset re-skins the workbook without touching a cell.
 *
 * **With a preset and no range, this writes the workbook's theme.** All nine
 * pairs go every time, because the API rejects a partial theme, and slots the
 * preset does not name are inherited from the sheet rather than reset to
 * Google's defaults. It also records the preset in developer metadata, so the
 * next session knows what this spreadsheet is styled with instead of guessing
 * from the colors.
 *
 * **Restyling somebody else's spreadsheet is not a formatting decision.** A
 * theme, a banding, or a clear on a sheet the registry marks human or shared
 * changes how every tab looks, including the tabs nobody asked about, so those
 * need `force` and a `reason` that says who asked.
 *
 * Two refusals are structural rather than stylistic. A merge inside a Table or
 * a data region is refused, because merges break sorting, filtering, and any
 * formula that crosses them; a title banner above the table is the shape that
 * works. And there is no footer color anywhere in this tool, because a Table's
 * `footerColorStyle` converts the last data row into a footer and overwrites
 * it with SUM formulas (spike 3).
 */
import { z } from "zod";
import type { ToolDefinition, ToolDeps } from "./types.js";
export declare const styleInputSchema: {
    spreadsheet_id: z.ZodString;
    sheet: z.ZodOptional<z.ZodString>;
    range: z.ZodOptional<z.ZodString>;
    preset: z.ZodOptional<z.ZodString>;
    archetype: z.ZodOptional<z.ZodEnum<{
        tracker: "tracker";
        model: "model";
    }>>;
    style: z.ZodOptional<z.ZodObject<{
        role: z.ZodOptional<z.ZodEnum<{
            input: "input";
            title: "title";
            ok: "ok";
            formula: "formula";
            header: "header";
            warn: "warn";
            band1: "band1";
            band2: "band2";
            flag: "flag";
            muted: "muted";
            cross_sheet: "cross_sheet";
        }>>;
        bold: z.ZodOptional<z.ZodBoolean>;
        italic: z.ZodOptional<z.ZodBoolean>;
        strikethrough: z.ZodOptional<z.ZodBoolean>;
        underline: z.ZodOptional<z.ZodBoolean>;
        font: z.ZodOptional<z.ZodString>;
        font_size: z.ZodOptional<z.ZodNumber>;
        text_color: z.ZodOptional<z.ZodString>;
        background: z.ZodOptional<z.ZodString>;
        align: z.ZodOptional<z.ZodEnum<{
            RIGHT: "RIGHT";
            LEFT: "LEFT";
            CENTER: "CENTER";
        }>>;
        vertical_align: z.ZodOptional<z.ZodEnum<{
            TOP: "TOP";
            MIDDLE: "MIDDLE";
            BOTTOM: "BOTTOM";
        }>>;
        wrap: z.ZodOptional<z.ZodEnum<{
            OVERFLOW_CELL: "OVERFLOW_CELL";
            CLIP: "CLIP";
            WRAP: "WRAP";
        }>>;
        number_format: z.ZodOptional<z.ZodString>;
        note: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    borders: z.ZodOptional<z.ZodObject<{
        edges: z.ZodUnion<readonly [z.ZodLiteral<"all">, z.ZodLiteral<"outer">, z.ZodArray<z.ZodEnum<{
            top: "top";
            bottom: "bottom";
            left: "left";
            right: "right";
            inner_horizontal: "inner_horizontal";
            inner_vertical: "inner_vertical";
        }>>]>;
        style: z.ZodOptional<z.ZodEnum<{
            DOUBLE: "DOUBLE";
            SOLID: "SOLID";
            SOLID_MEDIUM: "SOLID_MEDIUM";
            SOLID_THICK: "SOLID_THICK";
            DASHED: "DASHED";
            DOTTED: "DOTTED";
            NONE: "NONE";
        }>>;
        color: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    column_widths: z.ZodOptional<z.ZodArray<z.ZodObject<{
        columns: z.ZodString;
        pixels: z.ZodNumber;
    }, z.core.$strict>>>;
    row_heights: z.ZodOptional<z.ZodArray<z.ZodObject<{
        rows: z.ZodString;
        pixels: z.ZodNumber;
    }, z.core.$strict>>>;
    autofit: z.ZodOptional<z.ZodObject<{
        columns: z.ZodOptional<z.ZodString>;
        rows: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    banding: z.ZodOptional<z.ZodObject<{
        range: z.ZodOptional<z.ZodString>;
        header: z.ZodOptional<z.ZodBoolean>;
        first: z.ZodOptional<z.ZodString>;
        second: z.ZodOptional<z.ZodString>;
        remove: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    merge: z.ZodOptional<z.ZodObject<{
        range: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<{
            MERGE_ALL: "MERGE_ALL";
            MERGE_COLUMNS: "MERGE_COLUMNS";
            MERGE_ROWS: "MERGE_ROWS";
        }>>;
    }, z.core.$strict>>;
    unmerge: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodObject<{
        range: z.ZodString;
    }, z.core.$strict>]>>;
    clear: z.ZodOptional<z.ZodObject<{
        formats: z.ZodOptional<z.ZodBoolean>;
        banding: z.ZodOptional<z.ZodBoolean>;
        conditional_formats: z.ZodOptional<z.ZodBoolean>;
        merges: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    freeze_rows: z.ZodOptional<z.ZodNumber>;
    freeze_columns: z.ZodOptional<z.ZodNumber>;
    gridlines: z.ZodOptional<z.ZodBoolean>;
    tab_color: z.ZodOptional<z.ZodString>;
    force: z.ZodOptional<z.ZodBoolean>;
    reason: z.ZodOptional<z.ZodString>;
    dry_run: z.ZodOptional<z.ZodBoolean>;
    check: z.ZodOptional<z.ZodBoolean>;
};
export declare function createStyleTool(deps: ToolDeps): ToolDefinition<typeof styleInputSchema>;
//# sourceMappingURL=style.d.ts.map