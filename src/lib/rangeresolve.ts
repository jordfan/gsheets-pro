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

import {
  a1ToGridRange,
  columnIndexToLetter,
  gridRangeToA1,
  parseColumnSpan,
  parseRowSpan,
  quoteSheetName,
  splitSheetRange,
  type GridRange,
} from "./a1.js";
import { GsheetsError, err } from "./errors.js";

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

// ---------------------------------------------------------------------------
// Which fields hold a range, and which kind
// ---------------------------------------------------------------------------

/**
 * Fields whose value is a DimensionRange (a band of whole rows or columns).
 * Keyed by the path under the request type, so `insertDimension.range` is a
 * DimensionRange while `sortRange.range` is a GridRange.
 */
export const DIMENSION_RANGE_PATHS: readonly string[] = [
  "insertDimension.range",
  "deleteDimension.range",
  "moveDimension.source",
  "updateDimensionProperties.range",
  "autoResizeDimensions.dimensions",
  "addDimensionGroup.range",
  "deleteDimensionGroup.range",
  "updateDimensionGroup.dimensionGroup.range",
];

/** Field names that hold a range of some kind. */
export const RANGE_FIELD_NAMES: readonly string[] = [
  "range",
  "ranges",
  "gridRange",
  "sourceRange",
  "destinationRange",
  "dataRange",
  "source",
  "destination",
  "dimensions",
  "filterRange",
];

const DIMENSION_PATHS = new Set(DIMENSION_RANGE_PATHS);
const RANGE_FIELDS = new Set(RANGE_FIELD_NAMES);

/** Prose for the request types a person is most likely to reach for. */
const REQUEST_PROSE: Record<string, string> = {
  addChart: "add a chart",
  addBanding: "add alternating colours",
  addConditionalFormatRule: "add a conditional format rule",
  addDimensionGroup: "group rows or columns",
  addFilterView: "add a filter view",
  addNamedRange: "add a named range",
  addProtectedRange: "protect a range",
  addSheet: "add a tab",
  addSlicer: "add a slicer",
  addTable: "add a native Table",
  appendCells: "append cells",
  appendDimension: "add rows or columns at the end",
  autoFill: "fill a range from a pattern",
  autoResizeDimensions: "size rows or columns to their contents",
  clearBasicFilter: "remove the filter",
  copyPaste: "copy and paste a range",
  createDeveloperMetadata: "attach developer metadata",
  cutPaste: "cut and paste a range",
  deleteBanding: "remove alternating colours",
  deleteConditionalFormatRule: "delete a conditional format rule",
  deleteDeveloperMetadata: "delete developer metadata",
  deleteDimension: "delete rows or columns",
  deleteDimensionGroup: "ungroup rows or columns",
  deleteDuplicates: "delete duplicate rows",
  deleteEmbeddedObject: "delete a chart or image",
  deleteFilterView: "delete a filter view",
  deleteNamedRange: "delete a named range",
  deleteProtectedRange: "remove a protection",
  deleteRange: "delete a range and shift cells",
  deleteSheet: "delete a tab",
  deleteTable: "delete a native Table",
  duplicateFilterView: "duplicate a filter view",
  duplicateSheet: "duplicate a tab",
  findReplace: "find and replace",
  insertDimension: "insert rows or columns",
  insertRange: "insert cells and shift the rest",
  mergeCells: "merge cells",
  moveDimension: "move rows or columns",
  pasteData: "paste data",
  randomizeRange: "shuffle rows",
  repeatCell: "apply a format across a range",
  setBasicFilter: "set the filter",
  setDataValidation: "set a validation rule",
  sortRange: "sort a range",
  textToColumns: "split text into columns",
  trimWhitespace: "trim whitespace",
  unmergeCells: "unmerge cells",
  updateBanding: "change alternating colours",
  updateBorders: "change borders",
  updateCells: "write cells",
  updateConditionalFormatRule: "change a conditional format rule",
  updateDeveloperMetadata: "change developer metadata",
  updateDimensionGroup: "change a row or column group",
  updateDimensionProperties: "change row heights or column widths",
  updateEmbeddedObjectPosition: "move a chart or image",
  updateFilterView: "change a filter view",
  updateNamedRange: "change a named range",
  updateProtectedRange: "change a protection",
  updateSheetProperties: "change tab properties",
  updateSlicerSpec: "change a slicer",
  updateSpreadsheetProperties: "change spreadsheet properties",
  updateTable: "change a native Table",
};

/** Request types that change cell contents, so the gate is worth running. */
export const VALUE_CHANGING_REQUESTS: readonly string[] = [
  "appendCells",
  "autoFill",
  "copyPaste",
  "cutPaste",
  "deleteDimension",
  "deleteDuplicates",
  "deleteRange",
  "deleteSheet",
  "findReplace",
  "insertDimension",
  "insertRange",
  "mergeCells",
  "moveDimension",
  "pasteData",
  "randomizeRange",
  "sortRange",
  "textToColumns",
  "trimWhitespace",
  "updateCells",
  "updateTable",
];

export function describeRequestType(type: string): string {
  return REQUEST_PROSE[type] ?? type;
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** "'Roster'!A1:C10" for a resolved GridRange, or "'Roster'" for a whole tab. */
export function qualifiedA1(title: string, range: GridRange): string {
  const body = gridRangeToA1(range);
  return body === "the whole sheet" ? quoteSheetName(title) : `${quoteSheetName(title)}!${body}`;
}

function dimensionToA1(title: string, dimension: string, start: number, end: number): string {
  const body =
    dimension === "COLUMNS"
      ? `${columnIndexToLetter(start)}:${columnIndexToLetter(end - 1)}`
      : `${start + 1}:${end}`;
  return `${quoteSheetName(title)}!${body}`;
}

/**
 * Rewrite one batch of raw requests so the API will accept them, and describe
 * what they will do. Throws a teaching error rather than letting the API answer
 * with "Invalid requests[0]".
 */
export async function resolveRequests(
  rawRequests: unknown[],
  options: ResolveOptions,
): Promise<ResolveResult> {
  const requests: Array<Record<string, unknown>> = [];
  const plan: PlanEntry[] = [];
  const touched: string[] = [];
  const sheets: string[] = [];
  const unlocatable: string[] = [];

  const noteSheet = (title: string) => {
    if (title && !sheets.includes(title)) sheets.push(title);
  };
  const noteRange = (reference: string) => {
    if (reference && !touched.includes(reference)) touched.push(reference);
  };

  for (const [index, raw] of rawRequests.entries()) {
    if (!isPlainObject(raw)) {
      throw err.invalid(
        `requests[${index}] is not an object.`,
        'Each entry is one batchUpdate request keyed by its type, for example { "sortRange": { "range": "\'Roster\'!A2:F80", "sortSpecs": [...] } }.',
      );
    }
    const keys = Object.keys(raw);
    if (keys.length !== 1) {
      throw err.invalid(
        `requests[${index}] has ${keys.length} keys (${keys.join(", ") || "none"}), and a batchUpdate request has exactly one.`,
        "Split it into one entry per request type. The API reads the single key as the request type.",
      );
    }
    const type = keys[0];
    const targets: string[] = [];

    const resolved = await walk(raw[type], type, {
      options,
      requestType: type,
      onGridRange: async (range) => {
        const info = await options.resolveSheetId(range.sheetId);
        const title = info?.title ?? `sheet ${range.sheetId}`;
        const reference = qualifiedA1(title, range);
        if (info) noteSheet(info.title);
        noteRange(reference);
        targets.push(reference);
      },
      onDimensionRange: async (range) => {
        const info = await options.resolveSheetId(range.sheetId);
        const title = info?.title ?? `sheet ${range.sheetId}`;
        const reference = dimensionToA1(title, range.dimension, range.startIndex, range.endIndex);
        if (info) noteSheet(info.title);
        noteRange(reference);
        targets.push(reference);
      },
      onSheetId: async (sheetId) => {
        const info = await options.resolveSheetId(sheetId);
        if (info) {
          noteSheet(info.title);
          const reference = quoteSheetName(info.title);
          if (targets.length === 0) targets.push(reference);
        }
      },
    });

    requests.push({ [type]: resolved });
    if (targets.length === 0) unlocatable.push(type);
    plan.push({
      index,
      type,
      summary: describeRequestType(type),
      targets,
    });
  }

  return { requests, plan, touched, sheets, unlocatable };
}

interface WalkContext {
  options: ResolveOptions;
  requestType: string;
  onGridRange: (range: GridRange) => Promise<void>;
  onDimensionRange: (range: {
    sheetId: number;
    dimension: string;
    startIndex: number;
    endIndex: number;
  }) => Promise<void>;
  onSheetId: (sheetId: number) => Promise<void>;
}

async function walk(node: unknown, path: string, ctx: WalkContext): Promise<unknown> {
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const item of node) out.push(await walk(item, path, ctx));
    return out;
  }
  if (!isPlainObject(node)) return node;

  const out: Record<string, unknown> = {};
  // A GridRange or DimensionRange written out longhand still needs its sheetId
  // resolved and still counts as a touched range, so it is handled here rather
  // than only on the string path.
  let sheetIdValue: number | undefined;

  for (const [key, value] of Object.entries(node)) {
    const childPath = `${path}.${key}`;

    if (key === "sheetId" && typeof value === "string") {
      const info = await ctx.options.resolveSheet(value);
      sheetIdValue = info.sheetId;
      out[key] = info.sheetId;
      continue;
    }
    if (key === "sheetId" && typeof value === "number") {
      sheetIdValue = value;
      out[key] = value;
      continue;
    }

    if (typeof value === "string" && RANGE_FIELDS.has(key)) {
      out[key] = await stringToRange(value, childPath, ctx);
      continue;
    }
    if (Array.isArray(value) && RANGE_FIELDS.has(key) && value.every((v) => typeof v === "string")) {
      const converted: unknown[] = [];
      for (const item of value as string[]) converted.push(await stringToRange(item, childPath, ctx));
      out[key] = converted;
      continue;
    }

    out[key] = await walk(value, childPath, ctx);
  }

  await report(out, path, sheetIdValue, ctx);
  return out;
}

/**
 * Notice a range the caller wrote out longhand, so the dry run plan and the
 * error gate cover it the same way they cover one written as A1.
 */
async function report(
  node: Record<string, unknown>,
  path: string,
  sheetId: number | undefined,
  ctx: WalkContext,
): Promise<void> {
  if (sheetId === undefined) return;
  const hasGridBounds =
    "startRowIndex" in node ||
    "endRowIndex" in node ||
    "startColumnIndex" in node ||
    "endColumnIndex" in node;
  const hasDimension = typeof node["dimension"] === "string";

  if (hasDimension) {
    const start = Number(node["startIndex"] ?? 0);
    const end = Number(node["endIndex"] ?? start + 1);
    await ctx.onDimensionRange({
      sheetId,
      dimension: String(node["dimension"]),
      startIndex: start,
      endIndex: end,
    });
    return;
  }
  if (hasGridBounds || RANGE_FIELDS.has(path.split(".").pop() ?? "")) {
    const range: GridRange = { sheetId };
    for (const key of ["startRowIndex", "endRowIndex", "startColumnIndex", "endColumnIndex"] as const) {
      const value = node[key];
      if (typeof value === "number") range[key] = value;
    }
    await ctx.onGridRange(range);
    return;
  }
  await ctx.onSheetId(sheetId);
}

async function stringToRange(
  value: string,
  path: string,
  ctx: WalkContext,
): Promise<Record<string, unknown>> {
  const underRequest = path.slice(path.indexOf(".") + 1);
  const wantsDimension = DIMENSION_PATHS.has(`${ctx.requestType}.${underRequest}`);

  const split = splitSheetRange(value);
  const sheetName = split.sheet ?? ctx.options.defaultSheet;
  if (!sheetName) {
    throw err.invalid(
      `The range "${value}" at ${path} does not say which tab it is on.`,
      "Qualify it, for example 'Roster'!A2:F80, or pass sheet so unqualified ranges land on that tab.",
    );
  }
  const info = await ctx.options.resolveSheet(sheetName);

  if (wantsDimension) {
    const body = split.range.trim();
    if (!body) {
      throw err.invalid(
        `${path} needs a band of rows or columns and "${value}" names a whole tab.`,
        'Write it as rows ("5:9") or columns ("B:D").',
      );
    }
    const span = toSpan(body, value, path);
    const range = {
      sheetId: info.sheetId,
      dimension: span.dimension,
      startIndex: span.startIndex,
      endIndex: span.endIndex,
    };
    await ctx.onDimensionRange(range);
    return range;
  }

  const range = a1ToGridRange(split.range, info.sheetId);
  await ctx.onGridRange(range);
  return range as unknown as Record<string, unknown>;
}

function toSpan(
  body: string,
  original: string,
  path: string,
): { dimension: "ROWS" | "COLUMNS"; startIndex: number; endIndex: number } {
  if (/^[A-Za-z]{1,3}(:[A-Za-z]{1,3})?$/.test(body)) {
    const span = parseColumnSpan(body);
    return { dimension: "COLUMNS", startIndex: span.startIndex, endIndex: span.endIndex };
  }
  if (/^[0-9]+(:[0-9]+)?$/.test(body)) {
    const span = parseRowSpan(body);
    return { dimension: "ROWS", startIndex: span.startIndex, endIndex: span.endIndex };
  }
  throw new GsheetsError(
    "bad_range",
    `${path} wants whole rows or whole columns, and "${original}" names a block of cells.`,
    'Write columns as "B:D" or rows as "5:9". A block like A2:F80 belongs on a field that takes a GridRange, such as sortRange.range.',
  );
}
