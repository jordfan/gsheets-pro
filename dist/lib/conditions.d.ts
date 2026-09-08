/**
 * BooleanCondition, built from words a person would use.
 *
 * Data validation and conditional formatting are two tools over one API type.
 * Both take "the value is greater than 40" or "the text contains overdue", and
 * both have to turn that into one of the API's thirty odd condition types,
 * where the same idea is spelled `NUMBER_GREATER`, `TEXT_CONTAINS` or
 * `DATE_AFTER` depending on what is being compared.
 *
 * So the vocabulary here is one flat list of operators plus a `kind` that says
 * what is being compared. The kind is inferred when the operator only makes
 * sense one way, which is most of them, and the caller only has to say so for
 * the four operators that read the same for a number, a date and a string.
 */
export declare const CONDITION_OPERATORS: readonly ["greater_than", "greater_than_or_equal", "less_than", "less_than_or_equal", "equal", "not_equal", "between", "not_between", "contains", "not_contains", "starts_with", "ends_with", "is_email", "is_url", "before", "after", "on_or_before", "on_or_after", "is_valid_date", "blank", "not_blank", "one_of_list", "one_of_range", "custom_formula", "checkbox"];
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];
export declare const CONDITION_KINDS: readonly ["number", "text", "date"];
export type ConditionKind = (typeof CONDITION_KINDS)[number];
export interface ConditionSpec {
    operator: ConditionOperator;
    /** Only needed for the operators that read the same for every kind. */
    kind?: ConditionKind;
    /** The comparison value, or the first of two for a between. */
    value?: string | number | boolean;
    /** The second value of a between. */
    value2?: string | number | boolean;
    /** The options for one_of_list. */
    values?: Array<string | number | boolean>;
    /** The A1 range for one_of_range, tab name included. */
    source_range?: string;
    /** The formula for custom_formula, with or without the leading "=". */
    formula?: string;
}
export interface BooleanCondition {
    type: string;
    values?: Array<{
        userEnteredValue?: string;
        relativeDate?: string;
    }>;
}
/** The relative dates Sheets understands in place of a literal date. */
export declare const RELATIVE_DATES: readonly ["past_year", "past_month", "past_week", "yesterday", "today", "tomorrow"];
/** The kind a spec is comparing, inferred when the operator does not fix it. */
export declare function resolveKind(spec: ConditionSpec): ConditionKind;
/** Build the API's BooleanCondition, or throw a hint that teaches the fix. */
export declare function buildCondition(spec: ConditionSpec): BooleanCondition;
/** One line of prose for a condition, for the readable half of a response. */
export declare function describeCondition(condition: BooleanCondition | undefined): string;
//# sourceMappingURL=conditions.d.ts.map