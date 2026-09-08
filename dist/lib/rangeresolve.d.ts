/**
 * Resolving tab names and A1 into what `spreadsheets.batchUpdate` actually
 * wants.
 *
 * The escape hatch is only useful if it speaks the same language as the rest of
 * the surface. A person writing a raw request should be able to say
 *
 *   { "sortRange": { "range": "'Roster'!A2:F80", "sortSpecs": [...] } }
 *
 * rather than looking up that Roster is sheet id 148329471 and that A2:F80 is
 * startRowIndex 1, endRowIndex 80, startColumnIndex 0, endColumnIndex 6. Nobody
 * gets those four numbers right by hand, and the half open end index is the one
 * everybody gets wrong.
 *
 * So the resolver walks the request tree and rewrites two things:
 *
 * - a `sheetId` whose value is a string becomes the numeric id of that tab.
 * - a field that wants a range, given a string, becomes the object the API
 *   wants. Which object depends on the field: `insertDimension.range` is a
 *   DimensionRange and takes "5:9" or "B:D", while `sortRange.range` is a
 *   GridRange and takes "A2:F80". The table below says which is which; getting
 *   it wrong is a 400 with an unhelpful message.
 *
 * Everything else passes through untouched, because the point of an escape
 * hatch is that it does not second guess the caller.
 */
import { type GridRange } from "./a1.js";
export interface ResolvedSheet {
    sheetId: number;
    title: string;
}
export interface ResolveOptions {
    /** Tab name to sheet info. Usually `ctx.cache.resolve` bound to a spreadsheet. */
    resolveSheet: (name: string) => Promise<ResolvedSheet>;
    /** Numeric id back to a tab, so the plan can print names the caller recognises. */
    resolveSheetId: (sheetId: number) => Promise<ResolvedSheet | undefined>;
    /** Used when a range string carries no tab qualifier. */
    defaultSheet?: string;
}
/** One line of the dry run plan. */
export interface PlanEntry {
    index: number;
    /** "sortRange", the batchUpdate request type. */
    type: string;
    /** What it does, in words. */
    summary: string;
    /** Fully qualified A1 references this request names. */
    targets: string[];
}
export interface ResolveResult {
    requests: Array<Record<string, unknown>>;
    plan: PlanEntry[];
    /** Fully qualified A1 for every grid range the requests name, deduplicated. */
    touched: string[];
    /** Tab names the requests name, deduplicated. */
    sheets: string[];
    /** Request types that carry no range at all, so the gate cannot cover them. */
    unlocatable: string[];
}
/**
 * Fields whose value is a DimensionRange (a band of whole rows or columns).
 * Keyed by the path under the request type, so `insertDimension.range` is a
 * DimensionRange while `sortRange.range` is a GridRange.
 */
export declare const DIMENSION_RANGE_PATHS: readonly string[];
/** Field names that hold a range of some kind. */
export declare const RANGE_FIELD_NAMES: readonly string[];
/** Request types that change cell contents, so the gate is worth running. */
export declare const VALUE_CHANGING_REQUESTS: readonly string[];
export declare function describeRequestType(type: string): string;
/** "'Roster'!A1:C10" for a resolved GridRange, or "'Roster'" for a whole tab. */
export declare function qualifiedA1(title: string, range: GridRange): string;
/**
 * Rewrite one batch of raw requests so the API will accept them, and describe
 * what they will do. Throws a teaching error rather than letting the API answer
 * with "Invalid requests[0]".
 */
export declare function resolveRequests(rawRequests: unknown[], options: ResolveOptions): Promise<ResolveResult>;
//# sourceMappingURL=rangeresolve.d.ts.map