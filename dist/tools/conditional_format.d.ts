/**
 * `sheets_conditional_format`: rules that paint a cell according to what it says.
 *
 * The API addresses these rules by their index in a per sheet list, and those
 * indexes shift whenever anything is added or deleted, including by a person
 * working in the UI at the same time. So this tool never takes an index from
 * the caller. It takes a fingerprint of the rule's meaning, resolves it against
 * a list read in the same call, and refuses with the current list in hand when
 * the fingerprint no longer matches anything.
 *
 * The other job here is standing in for chip colors. A dropdown's colors cannot
 * be set through the API at all, so a status column that a person would colour
 * with chips is coloured here with one boolean rule per option, drawn from the
 * preset's ok, warn, flag and muted roles.
 */
import { z } from "zod";
import { type CfRule } from "../lib/cfrules.js";
import { type Preset } from "../lib/tablecolors.js";
import type { ToolDefinition, ToolDeps } from "./types.js";
export declare const conditionalFormatInputSchema: {
    spreadsheet_id: z.ZodString;
    action: z.ZodEnum<{
        list: "list";
        add: "add";
        update: "update";
        delete: "delete";
    }>;
    sheet: z.ZodOptional<z.ZodString>;
    ranges: z.ZodOptional<z.ZodArray<z.ZodString>>;
    fingerprint: z.ZodOptional<z.ZodString>;
    kind: z.ZodOptional<z.ZodEnum<{
        boolean: "boolean";
        gradient: "gradient";
    }>>;
    operator: z.ZodOptional<z.ZodEnum<{
        contains: "contains";
        not_contains: "not_contains";
        starts_with: "starts_with";
        ends_with: "ends_with";
        blank: "blank";
        not_blank: "not_blank";
        greater_than: "greater_than";
        greater_than_or_equal: "greater_than_or_equal";
        less_than: "less_than";
        less_than_or_equal: "less_than_or_equal";
        equal: "equal";
        not_equal: "not_equal";
        between: "between";
        not_between: "not_between";
        is_email: "is_email";
        is_url: "is_url";
        before: "before";
        after: "after";
        on_or_before: "on_or_before";
        on_or_after: "on_or_after";
        is_valid_date: "is_valid_date";
        one_of_list: "one_of_list";
        one_of_range: "one_of_range";
        custom_formula: "custom_formula";
        checkbox: "checkbox";
    }>>;
    value_kind: z.ZodOptional<z.ZodEnum<{
        number: "number";
        date: "date";
        text: "text";
    }>>;
    value: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>;
    value2: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>;
    values: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>>;
    formula: z.ZodOptional<z.ZodString>;
    format: z.ZodOptional<z.ZodObject<{
        fill: z.ZodOptional<z.ZodString>;
        text_color: z.ZodOptional<z.ZodString>;
        bold: z.ZodOptional<z.ZodBoolean>;
        italic: z.ZodOptional<z.ZodBoolean>;
        strikethrough: z.ZodOptional<z.ZodBoolean>;
        underline: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    gradient: z.ZodOptional<z.ZodObject<{
        min: z.ZodObject<{
            type: z.ZodEnum<{
                PERCENT: "PERCENT";
                NUMBER: "NUMBER";
                MIN: "MIN";
                MAX: "MAX";
                PERCENTILE: "PERCENTILE";
            }>;
            value: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            color: z.ZodString;
        }, z.core.$strip>;
        mid: z.ZodOptional<z.ZodObject<{
            type: z.ZodEnum<{
                PERCENT: "PERCENT";
                NUMBER: "NUMBER";
                MIN: "MIN";
                MAX: "MAX";
                PERCENTILE: "PERCENTILE";
            }>;
            value: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            color: z.ZodString;
        }, z.core.$strip>>;
        max: z.ZodObject<{
            type: z.ZodEnum<{
                PERCENT: "PERCENT";
                NUMBER: "NUMBER";
                MIN: "MIN";
                MAX: "MAX";
                PERCENTILE: "PERCENTILE";
            }>;
            value: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            color: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>>;
    preset: z.ZodOptional<z.ZodString>;
    index: z.ZodOptional<z.ZodNumber>;
    dry_run: z.ZodOptional<z.ZodBoolean>;
    force: z.ZodOptional<z.ZodBoolean>;
};
export declare function createConditionalFormatTool(deps: ToolDeps): ToolDefinition<typeof conditionalFormatInputSchema>;
/** Exported for the Table tool, which paints status fills through this shape. */
export declare function statusRuleFor(sheetId: number, rangeA1: string, option: string, fill: string, preset: Preset): CfRule;
/** The tab qualified A1 of a rule's ranges, for a readable response. */
export declare function ruleRangeText(sheet: string, rule: CfRule): string;
//# sourceMappingURL=conditional_format.d.ts.map