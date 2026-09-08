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
import { type NullableBounds } from "./a1.js";
import { type ColorStyle } from "./colors.js";
import { type BooleanCondition } from "./conditions.js";
export interface CfGridRange extends NullableBounds {
    sheetId?: number | null;
}
export interface CfCellFormat {
    backgroundColorStyle?: ColorStyle;
    textFormat?: {
        bold?: boolean;
        italic?: boolean;
        strikethrough?: boolean;
        underline?: boolean;
        foregroundColorStyle?: ColorStyle;
    };
}
export interface CfInterpolationPoint {
    type: string;
    value?: string;
    colorStyle?: ColorStyle;
}
export interface CfRule {
    ranges?: CfGridRange[];
    booleanRule?: {
        condition?: BooleanCondition;
        format?: CfCellFormat;
    };
    gradientRule?: {
        minpoint?: CfInterpolationPoint;
        midpoint?: CfInterpolationPoint;
        maxpoint?: CfInterpolationPoint;
    };
}
/**
 * A color as one comparable string, whichever of the API's two shapes it
 * arrived in. Channels are rounded to bytes first: the API answers with floats
 * and 0.09411765 has to fingerprint the same as the 0.094 we sent.
 */
export declare function canonicalColor(style: {
    rgbColor?: {
        red?: number | null;
        green?: number | null;
        blue?: number | null;
    } | null;
    themeColor?: string | null;
} | null | undefined, legacy?: {
    red?: number | null;
    green?: number | null;
    blue?: number | null;
} | null): string | undefined;
/** Everything about a rule except where it sits in the list. */
export declare function canonicalMeaning(rule: CfRule): unknown;
/**
 * The stable name of a rule: what it does, then where it does it, as two
 * halves of one string. Keeping the halves separable is what lets a rule whose
 * ranges have shifted still be found by a fingerprint taken before the shift.
 */
export declare function fingerprintRule(rule: CfRule): string;
/** The first half alone: what the rule does, ignoring where. */
export declare function meaningFingerprint(rule: CfRule): string;
/** The meaning half of any fingerprint, whichever form it arrived in. */
export declare function meaningPartOf(fingerprint: string): string;
export interface FingerprintMatch {
    index: number;
    rule: CfRule;
    fingerprint: string;
    /** exact: ranges matched too. moved: same rule, different ranges. */
    match: "exact" | "moved";
}
export interface FingerprintMiss {
    reason: "not_found" | "ambiguous";
    /** Every rule on the sheet, so the caller can pick without another read. */
    candidates: Array<{
        index: number;
        fingerprint: string;
        summary: string;
    }>;
}
/**
 * Find the rule a fingerprint names. An exact hit wins. Failing that, a single
 * rule doing the same thing somewhere else is treated as the same rule that has
 * moved, and the caller is told. Two such rules are ambiguous and the caller
 * has to say which.
 */
export declare function resolveFingerprint(rules: CfRule[], fingerprint: string): FingerprintMatch | FingerprintMiss;
export declare function isMatch(value: FingerprintMatch | FingerprintMiss): value is FingerprintMatch;
export interface FormatSpec {
    /** A preset role, a theme slot, or a hex color. */
    fill?: string;
    text_color?: string;
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
}
/**
 * The CellFormat a boolean rule paints. Only the properties the caller named
 * are set: a conditional format overlays the cell's own formatting, so naming a
 * property the caller did not ask for would override something a person chose.
 */
export declare function buildCellFormat(spec: FormatSpec, resolve: (token: string) => ColorStyle): CfCellFormat | undefined;
/** "A2:A40 turns #F5E2E0 when the text is Overdue". */
export declare function describeRule(rule: CfRule): string;
/** The columns a rule covers, for a one line summary. */
export declare function rangeColumns(range: CfGridRange): string | undefined;
//# sourceMappingURL=cfrules.d.ts.map