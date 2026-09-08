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
export const DEFAULT_LEAF_FIELDS: readonly string[] = [
  "numberFormat",
  "padding",
  "textRotation",
  "textFormat.link",
  "link",
  "condition",
  "dataValidation",
  "boolean",
  "gradient",
  "developerMetadataLookup",
];

const DEFAULT_LEAVES = new Set(DEFAULT_LEAF_FIELDS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function isLeafField(name: string, path: string, leaves: Set<string>): boolean {
  if (leaves.has(name) || leaves.has(path)) return true;
  // Every color field is set whole: rgbColor and themeColor are alternatives,
  // and masking one of them alone leaves the other stale.
  return /Color(Style)?$/.test(name);
}

/**
 * The list of masked paths for a request body, in the order they appear.
 * Duplicates are collapsed; an empty object contributes nothing.
 */
export function fieldMaskPaths(value: unknown, options: FieldMaskOptions = {}): string[] {
  const leaves = new Set<string>(options.leaves ?? DEFAULT_LEAVES);
  for (const extra of options.extraLeaves ?? []) leaves.add(extra);

  const out: string[] = [];
  const seen = new Set<string>();

  const push = (path: string) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    out.push(path);
  };

  const walk = (node: unknown, path: string): void => {
    if (node === undefined) return;
    if (!isPlainObject(node)) {
      push(path);
      return;
    }
    const keys = Object.keys(node);
    if (keys.length === 0) {
      // An empty object still asks for the field, which is how a caller says
      // "reset this subtree to its default".
      push(path);
      return;
    }
    for (const key of keys) {
      const child = (node as Record<string, unknown>)[key];
      if (child === undefined) continue;
      const childPath = path ? `${path}.${key}` : key;
      if (child === null || isLeafField(key, childPath, leaves)) {
        push(childPath);
        continue;
      }
      walk(child, childPath);
    }
  };

  walk(value, options.prefix ?? "");
  return out;
}

/** The comma joined mask the Sheets API wants. */
export function buildFieldMask(value: unknown, options: FieldMaskOptions = {}): string {
  return fieldMaskPaths(value, options).join(",");
}

/**
 * Drop every `undefined` so the body sent matches the mask exactly. Nulls
 * survive, because a masked null is how a field gets cleared.
 */
export function pruneUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => pruneUndefined(v)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      out[key] = pruneUndefined(child);
    }
    return out as unknown as T;
  }
  return value;
}

/** True when the object carries no field worth sending. */
export function isEmptyRequest(value: unknown): boolean {
  return fieldMaskPaths(value).length === 0;
}
