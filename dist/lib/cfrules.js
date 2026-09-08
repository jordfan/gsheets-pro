/**
 * Conditional format rules: building them, and naming them.
 *
 * The API addresses a conditional format rule by its index in the sheet's list,
 * and those indexes shift the moment anything is added or deleted. An agent
 * that reads rule 3, thinks about it, and then updates rule 3 will eventually
 * rewrite a rule it never looked at.
 *
 * So rules are addressed here by a fingerprint of what they are: the ranges
 * they cover, the condition they test, and the format they paint. A fingerprint
 * is resolved back to an index at the moment of the call, against a list read
 * in the same call. When it resolves to nothing, the tool says so and shows
 * what is actually there rather than guessing at a neighbour.
 *
 * The fingerprint is deliberately computed from the rule's meaning, not from
 * its position, so it survives other rules being added and deleted around it.
 * It does change when the rule's own ranges move, which is why a miss falls
 * back to matching on condition and format alone and says that it did.
 */
import { createHash } from "node:crypto";
import { columnIndexToLetter, gridRangeToA1 } from "./a1.js";
import { colorToHex } from "./colors.js";
import { describeCondition } from "./conditions.js";
// ---------------------------------------------------------------------------
// Canonical form
// ---------------------------------------------------------------------------
/**
 * A color as one comparable string, whichever of the API's two shapes it
 * arrived in. Channels are rounded to bytes first: the API answers with floats
 * and 0.09411765 has to fingerprint the same as the 0.094 we sent.
 */
export function canonicalColor(style, legacy) {
    if (style?.themeColor)
        return `theme:${style.themeColor}`;
    if (style?.rgbColor)
        return colorToHex(style.rgbColor);
    if (legacy)
        return colorToHex(legacy);
    return undefined;
}
function canonicalRanges(ranges) {
    return (ranges ?? [])
        .map((r) => [
        r.sheetId ?? "",
        r.startRowIndex ?? "",
        r.endRowIndex ?? "",
        r.startColumnIndex ?? "",
        r.endColumnIndex ?? "",
    ].join(","))
        .sort();
}
function canonicalCondition(condition) {
    if (!condition)
        return null;
    return {
        type: condition.type ?? "",
        values: (condition.values ?? []).map((v) => v.relativeDate ?? v.userEnteredValue ?? ""),
    };
}
function canonicalFormat(format) {
    if (!format)
        return null;
    const raw = format;
    const text = format.textFormat ?? {};
    return {
        fill: canonicalColor(format.backgroundColorStyle, raw.backgroundColor) ?? "",
        bold: text.bold === true,
        italic: text.italic === true,
        strikethrough: text.strikethrough === true,
        underline: text.underline === true,
        color: canonicalColor(text.foregroundColorStyle, raw.textFormat?.foregroundColor) ?? "",
    };
}
function canonicalPoint(point) {
    if (!point)
        return null;
    const raw = point;
    return {
        type: point.type ?? "",
        value: point.value ?? "",
        color: canonicalColor(point.colorStyle, raw.color) ?? "",
    };
}
/** Everything about a rule except where it sits in the list. */
export function canonicalMeaning(rule) {
    return {
        kind: rule.gradientRule ? "gradient" : "boolean",
        condition: canonicalCondition(rule.booleanRule?.condition),
        format: canonicalFormat(rule.booleanRule?.format),
        gradient: rule.gradientRule
            ? {
                min: canonicalPoint(rule.gradientRule.minpoint),
                mid: canonicalPoint(rule.gradientRule.midpoint),
                max: canonicalPoint(rule.gradientRule.maxpoint),
            }
            : null,
    };
}
function digest(value, length) {
    return createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, length);
}
/**
 * The stable name of a rule: what it does, then where it does it, as two
 * halves of one string. Keeping the halves separable is what lets a rule whose
 * ranges have shifted still be found by a fingerprint taken before the shift.
 */
export function fingerprintRule(rule) {
    return `cf_${digest(canonicalMeaning(rule), 10)}_${digest(canonicalRanges(rule.ranges), 6)}`;
}
/** The first half alone: what the rule does, ignoring where. */
export function meaningFingerprint(rule) {
    return `cf_${digest(canonicalMeaning(rule), 10)}`;
}
/** The meaning half of any fingerprint, whichever form it arrived in. */
export function meaningPartOf(fingerprint) {
    const s = String(fingerprint ?? "").trim();
    const m = /^(cf_[0-9a-f]{10})(?:_[0-9a-f]{1,16})?$/.exec(s);
    return m ? m[1] : s;
}
/**
 * Find the rule a fingerprint names. An exact hit wins. Failing that, a single
 * rule doing the same thing somewhere else is treated as the same rule that has
 * moved, and the caller is told. Two such rules are ambiguous and the caller
 * has to say which.
 */
export function resolveFingerprint(rules, fingerprint) {
    const wanted = String(fingerprint ?? "").trim();
    const wantedMeaning = meaningPartOf(wanted);
    const withPrints = rules.map((rule, index) => ({
        index,
        rule,
        fingerprint: fingerprintRule(rule),
        meaning: meaningFingerprint(rule),
    }));
    const exact = withPrints.filter((r) => r.fingerprint === wanted);
    if (exact.length === 1) {
        return { index: exact[0].index, rule: exact[0].rule, fingerprint: exact[0].fingerprint, match: "exact" };
    }
    // A fingerprint from an earlier read still names the rule after its ranges
    // shift, which is what happens when rows are inserted above it.
    const byMeaning = withPrints.filter((r) => r.meaning === wantedMeaning);
    if (byMeaning.length === 1) {
        return {
            index: byMeaning[0].index,
            rule: byMeaning[0].rule,
            fingerprint: byMeaning[0].fingerprint,
            match: "moved",
        };
    }
    return {
        reason: byMeaning.length > 1 ? "ambiguous" : "not_found",
        candidates: withPrints.map((r) => ({
            index: r.index,
            fingerprint: r.fingerprint,
            summary: describeRule(r.rule),
        })),
    };
}
export function isMatch(value) {
    return value.index !== undefined;
}
/**
 * The CellFormat a boolean rule paints. Only the properties the caller named
 * are set: a conditional format overlays the cell's own formatting, so naming a
 * property the caller did not ask for would override something a person chose.
 */
export function buildCellFormat(spec, resolve) {
    const format = {};
    if (spec.fill)
        format.backgroundColorStyle = resolve(spec.fill);
    const text = {};
    if (spec.text_color)
        text.foregroundColorStyle = resolve(spec.text_color);
    if (spec.bold !== undefined)
        text.bold = spec.bold;
    if (spec.italic !== undefined)
        text.italic = spec.italic;
    if (spec.strikethrough !== undefined)
        text.strikethrough = spec.strikethrough;
    if (spec.underline !== undefined)
        text.underline = spec.underline;
    if (Object.keys(text).length > 0)
        format.textFormat = text;
    return Object.keys(format).length > 0 ? format : undefined;
}
// ---------------------------------------------------------------------------
// Prose
// ---------------------------------------------------------------------------
/** "A2:A40 turns #F5E2E0 when the text is Overdue". */
export function describeRule(rule) {
    const where = (rule.ranges ?? []).map((r) => gridRangeToA1(r)).join(", ") || "no range";
    if (rule.gradientRule) {
        const points = ["minpoint", "midpoint", "maxpoint"];
        const parts = points
            .map((key) => {
            const point = rule.gradientRule?.[key];
            if (!point)
                return undefined;
            const color = canonicalColor(point.colorStyle, point.color);
            return `${point.type.toLowerCase()}${point.value ? ` ${point.value}` : ""}${color ? ` ${color}` : ""}`;
        })
            .filter((p) => !!p);
        return `${where}: a colour scale from ${parts.join(" to ")}`;
    }
    const condition = describeCondition(rule.booleanRule?.condition);
    const format = rule.booleanRule?.format;
    const paints = [];
    const fill = canonicalColor(format?.backgroundColorStyle, format?.backgroundColor);
    if (fill)
        paints.push(`fills ${fill}`);
    if (format?.textFormat?.bold)
        paints.push("goes bold");
    if (format?.textFormat?.italic)
        paints.push("goes italic");
    if (format?.textFormat?.strikethrough)
        paints.push("is struck through");
    const textColor = canonicalColor(format?.textFormat?.foregroundColorStyle);
    if (textColor)
        paints.push(`takes text colour ${textColor}`);
    return `${where}: ${paints.join(", ") || "no visible format"} when ${condition}`;
}
/** The columns a rule covers, for a one line summary. */
export function rangeColumns(range) {
    const start = range.startColumnIndex;
    const end = range.endColumnIndex;
    if (start === undefined || start === null)
        return undefined;
    const first = columnIndexToLetter(start);
    if (end === undefined || end === null)
        return `${first}:`;
    const last = columnIndexToLetter(end - 1);
    return first === last ? first : `${first}:${last}`;
}
//# sourceMappingURL=cfrules.js.map