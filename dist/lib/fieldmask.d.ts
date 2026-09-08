/**
 * Field masks, built by walking the object we are about to send.
 *
 * Sheets writes are destructive over whatever the mask covers: a mask of
 * `userEnteredFormat` replaces the entire format of every cell in the range,
 * wiping the number format a colleague set even though we never mentioned it.
 * So the mask has to name exactly the fields the caller actually passed, and
 * the only reliable way to know those is to walk the request object rather than
 * to assemble the mask by hand alongside it.
 *
 * Two rules make the walk correct for this API:
 *
 * - `undefined` means "not passed" and is skipped. `null` means "clear this
 *   field" and IS masked, because Sheets clears anything the mask covers and
 *   the body leaves out.
 * - Some nested objects are single values that only make sense whole. A color
 *   is one of them, and so is a number format, whose type and pattern must
 *   agree. Those are masked at their own path and not walked into.
 */
export interface FieldMaskOptions {
    /** Prepended to every path, for example "userEnteredFormat". */
    prefix?: string;
    /**
     * Field names that are masked whole rather than walked into. Replaces the
     * default set when given; use `extraLeaves` to add to it instead.
     */
    leaves?: Iterable<string>;
    /** Field names added to the default leaf set. */
    extraLeaves?: Iterable<string>;
}
/**
 * Objects the Sheets API treats as one value. Anything matching `*Color` or
 * `*ColorStyle` is also a leaf, handled by pattern below.
 */
export declare const DEFAULT_LEAF_FIELDS: readonly string[];
/**
 * The list of masked paths for a request body, in the order they appear.
 * Duplicates are collapsed; an empty object contributes nothing.
 */
export declare function fieldMaskPaths(value: unknown, options?: FieldMaskOptions): string[];
/** The comma joined mask the Sheets API wants. */
export declare function buildFieldMask(value: unknown, options?: FieldMaskOptions): string;
/**
 * Drop every `undefined` so the body sent matches the mask exactly. Nulls
 * survive, because a masked null is how a field gets cleared.
 */
export declare function pruneUndefined<T>(value: T): T;
/** True when the object carries no field worth sending. */
export declare function isEmptyRequest(value: unknown): boolean;
//# sourceMappingURL=fieldmask.d.ts.map