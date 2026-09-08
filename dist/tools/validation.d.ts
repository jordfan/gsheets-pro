/**
 * `sheets_validation`: dropdowns, checkboxes, and the rest of the rules that
 * decide what a cell will accept.
 *
 * The whole tool turns on one restraint. The Sheets API has no color field on
 * any validation rule, so the chip colors a person picked in the UI cannot be
 * read and cannot be written back. Spike 4 settled what that costs: re-applying
 * `setDataValidation` with a condition byte-identical to the one already there
 * wiped the colors a person had set by hand, with renders before and after to
 * prove it, and a success response that said nothing. So a dropdown the plugin
 * did not create is treated as the human's: reported, not touched, and changed
 * only when the caller passes `force` and accepts losing the colors.
 *
 * The second restraint comes from spike 3. On a native Table, a DROPDOWN
 * column's rule lives on the Table's column properties and not on its cells, so
 * setting cell validation there fights the Table rather than editing it. That
 * case is sent to `sheets_table update`.
 */
import { z } from "zod";
import type { ToolDefinition, ToolDeps } from "./types.js";
export declare const VALIDATION_TYPES: readonly ["list", "source_range", "checkbox", "date", "number", "text", "custom", "clear"];
export declare const validationInputSchema: {
    spreadsheet_id: z.ZodString;
    sheet: z.ZodString;
    range: z.ZodString;
    type: z.ZodEnum<{
        number: "number";
        date: "date";
        custom: "custom";
        text: "text";
        checkbox: "checkbox";
        list: "list";
        clear: "clear";
        source_range: "source_range";
    }>;
    values: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>>;
    source_range: z.ZodOptional<z.ZodString>;
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
    kind: z.ZodOptional<z.ZodEnum<{
        number: "number";
        date: "date";
        text: "text";
    }>>;
    value: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>;
    value2: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>;
    formula: z.ZodOptional<z.ZodString>;
    help: z.ZodOptional<z.ZodString>;
    strict: z.ZodOptional<z.ZodBoolean>;
    show_dropdown: z.ZodOptional<z.ZodBoolean>;
    force: z.ZodOptional<z.ZodBoolean>;
    dry_run: z.ZodOptional<z.ZodBoolean>;
};
export declare function createValidationTool(deps: ToolDeps): ToolDefinition<typeof validationInputSchema>;
//# sourceMappingURL=validation.d.ts.map