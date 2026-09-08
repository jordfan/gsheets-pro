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
import { GsheetsError } from "./errors.js";
export const CONDITION_OPERATORS = [
    "greater_than",
    "greater_than_or_equal",
    "less_than",
    "less_than_or_equal",
    "equal",
    "not_equal",
    "between",
    "not_between",
    "contains",
    "not_contains",
    "starts_with",
    "ends_with",
    "is_email",
    "is_url",
    "before",
    "after",
    "on_or_before",
    "on_or_after",
    "is_valid_date",
    "blank",
    "not_blank",
    "one_of_list",
    "one_of_range",
    "custom_formula",
    "checkbox",
];
export const CONDITION_KINDS = ["number", "text", "date"];
/** Operators whose meaning fixes the kind, so nobody has to say it. */
const FIXED_KIND = {
    contains: "text",
    not_contains: "text",
    starts_with: "text",
    ends_with: "text",
    is_email: "text",
    is_url: "text",
    before: "date",
    after: "date",
    on_or_before: "date",
    on_or_after: "date",
    is_valid_date: "date",
};
const BY_KIND = {
    number: {
        greater_than: "NUMBER_GREATER",
        greater_than_or_equal: "NUMBER_GREATER_THAN_EQ",
        less_than: "NUMBER_LESS",
        less_than_or_equal: "NUMBER_LESS_THAN_EQ",
        equal: "NUMBER_EQ",
        not_equal: "NUMBER_NOT_EQ",
        between: "NUMBER_BETWEEN",
        not_between: "NUMBER_NOT_BETWEEN",
    },
    text: {
        equal: "TEXT_EQ",
        not_equal: "TEXT_NOT_EQ",
        contains: "TEXT_CONTAINS",
        not_contains: "TEXT_NOT_CONTAINS",
        starts_with: "TEXT_STARTS_WITH",
        ends_with: "TEXT_ENDS_WITH",
        is_email: "TEXT_IS_EMAIL",
        is_url: "TEXT_IS_URL",
    },
    date: {
        equal: "DATE_EQ",
        not_equal: "DATE_NOT_EQ",
        before: "DATE_BEFORE",
        after: "DATE_AFTER",
        on_or_before: "DATE_ON_OR_BEFORE",
        on_or_after: "DATE_ON_OR_AFTER",
        between: "DATE_BETWEEN",
        not_between: "DATE_NOT_BETWEEN",
        is_valid_date: "DATE_IS_VALID",
    },
};
/** The relative dates Sheets understands in place of a literal date. */
export const RELATIVE_DATES = [
    "past_year",
    "past_month",
    "past_week",
    "yesterday",
    "today",
    "tomorrow",
];
const RELATIVE_SET = new Set(RELATIVE_DATES);
function conditionValue(raw, kind) {
    const text = String(raw);
    if (kind === "date" && RELATIVE_SET.has(text.trim().toLowerCase())) {
        return { relativeDate: text.trim().toUpperCase() };
    }
    return { userEnteredValue: text };
}
function needsValue(spec, which) {
    const raw = spec[which];
    if (raw === undefined || raw === null || raw === "") {
        throw new GsheetsError("invalid_argument", `The ${spec.operator} condition needs ${which === "value" ? "a value" : "a second value"}.`, which === "value2"
            ? "A between needs both ends: pass value and value2."
            : "Pass value, for example value: 40.");
    }
    return raw;
}
/** The kind a spec is comparing, inferred when the operator does not fix it. */
export function resolveKind(spec) {
    const fixed = FIXED_KIND[spec.operator];
    if (fixed)
        return fixed;
    if (spec.kind)
        return spec.kind;
    const sample = spec.value;
    if (typeof sample === "number")
        return "number";
    if (typeof sample === "string") {
        if (sample.trim() !== "" && Number.isFinite(Number(sample)))
            return "number";
        if (RELATIVE_SET.has(sample.trim().toLowerCase()))
            return "date";
        if (/^\d{4}-\d{2}-\d{2}$/.test(sample.trim()))
            return "date";
        return "text";
    }
    return "number";
}
/** Build the API's BooleanCondition, or throw a hint that teaches the fix. */
export function buildCondition(spec) {
    const operator = spec.operator;
    if (operator === "blank")
        return { type: "BLANK" };
    if (operator === "not_blank")
        return { type: "NOT_BLANK" };
    if (operator === "checkbox") {
        const values = (spec.values ?? []).map((v) => ({ userEnteredValue: String(v) }));
        return values.length ? { type: "BOOLEAN", values } : { type: "BOOLEAN" };
    }
    if (operator === "custom_formula") {
        const formula = String(spec.formula ?? spec.value ?? "").trim();
        if (!formula) {
            throw new GsheetsError("invalid_argument", "A custom_formula condition needs a formula.", 'Pass formula, for example formula: "=AND($D2>0, $E2=\\"Confirmed\\")". Write it as if for the first cell of the range; Sheets fills the rest down.');
        }
        return {
            type: "CUSTOM_FORMULA",
            values: [{ userEnteredValue: formula.startsWith("=") ? formula : `=${formula}` }],
        };
    }
    if (operator === "one_of_list") {
        const values = spec.values ?? [];
        if (values.length === 0) {
            throw new GsheetsError("invalid_argument", "A one_of_list condition needs the list of options.", 'Pass values, for example values: ["Confirmed", "Pending", "Declined"].');
        }
        return {
            type: "ONE_OF_LIST",
            values: values.map((v) => ({ userEnteredValue: String(v) })),
        };
    }
    if (operator === "one_of_range") {
        const range = String(spec.source_range ?? "").trim();
        if (!range) {
            throw new GsheetsError("invalid_argument", "A one_of_range condition needs the range the options come from.", 'Pass source_range with the tab name, for example source_range: "Lists!A2:A20".');
        }
        return {
            type: "ONE_OF_RANGE",
            values: [{ userEnteredValue: range.startsWith("=") ? range : `=${range}` }],
        };
    }
    const kind = resolveKind(spec);
    const type = BY_KIND[kind][operator];
    if (!type) {
        const usable = Object.keys(BY_KIND[kind]).join(", ");
        throw new GsheetsError("invalid_argument", `The operator ${operator} does not apply to a ${kind}.`, `On a ${kind} the operators are: ${usable}.`);
    }
    if (operator === "is_email" || operator === "is_url" || operator === "is_valid_date") {
        return { type };
    }
    if (operator === "between" || operator === "not_between") {
        return {
            type,
            values: [
                conditionValue(needsValue(spec, "value"), kind),
                conditionValue(needsValue(spec, "value2"), kind),
            ],
        };
    }
    return { type, values: [conditionValue(needsValue(spec, "value"), kind)] };
}
/** One line of prose for a condition, for the readable half of a response. */
export function describeCondition(condition) {
    if (!condition?.type)
        return "no condition";
    const values = (condition.values ?? [])
        .map((v) => v.relativeDate ?? v.userEnteredValue ?? "")
        .filter((v) => v !== "");
    const list = values.join(" and ");
    switch (condition.type) {
        case "BLANK":
            return "the cell is empty";
        case "NOT_BLANK":
            return "the cell is not empty";
        case "BOOLEAN":
            return values.length ? `a checkbox using ${list}` : "a checkbox";
        case "CUSTOM_FORMULA":
            return `the formula ${list} is true`;
        case "ONE_OF_LIST":
            return `one of ${values.length} options (${values.slice(0, 6).join(", ")}${values.length > 6 ? ", ..." : ""})`;
        case "ONE_OF_RANGE":
            return `one of the values in ${list}`;
        case "TEXT_CONTAINS":
            return `the text contains ${list}`;
        case "TEXT_NOT_CONTAINS":
            return `the text does not contain ${list}`;
        case "TEXT_STARTS_WITH":
            return `the text starts with ${list}`;
        case "TEXT_ENDS_WITH":
            return `the text ends with ${list}`;
        case "TEXT_EQ":
            return `the text is ${list}`;
        case "TEXT_NOT_EQ":
            return `the text is not ${list}`;
        case "TEXT_IS_EMAIL":
            return "the text is an email address";
        case "TEXT_IS_URL":
            return "the text is a URL";
        case "NUMBER_GREATER":
            return `the number is greater than ${list}`;
        case "NUMBER_GREATER_THAN_EQ":
            return `the number is ${list} or more`;
        case "NUMBER_LESS":
            return `the number is less than ${list}`;
        case "NUMBER_LESS_THAN_EQ":
            return `the number is ${list} or less`;
        case "NUMBER_EQ":
            return `the number is ${list}`;
        case "NUMBER_NOT_EQ":
            return `the number is not ${list}`;
        case "NUMBER_BETWEEN":
            return `the number is between ${list}`;
        case "NUMBER_NOT_BETWEEN":
            return `the number is outside ${list}`;
        case "DATE_BEFORE":
            return `the date is before ${list}`;
        case "DATE_AFTER":
            return `the date is after ${list}`;
        case "DATE_ON_OR_BEFORE":
            return `the date is on or before ${list}`;
        case "DATE_ON_OR_AFTER":
            return `the date is on or after ${list}`;
        case "DATE_EQ":
            return `the date is ${list}`;
        case "DATE_NOT_EQ":
            return `the date is not ${list}`;
        case "DATE_BETWEEN":
            return `the date is between ${list}`;
        case "DATE_NOT_BETWEEN":
            return `the date is outside ${list}`;
        case "DATE_IS_VALID":
            return "the value is a valid date";
        default:
            return `${condition.type}${list ? ` ${list}` : ""}`.toLowerCase();
    }
}
//# sourceMappingURL=conditions.js.map