/**
 * Native Tables: the typed columns, the contract metadata that rides them, and
 * the status fills that stand in for chip colors.
 *
 * Everything here is pure. The tool assembles requests from these functions and
 * sends them in one batchUpdate; the functions themselves never touch the API,
 * so every rule below is tested offline.
 *
 * Three findings from spike 3 are encoded here rather than left to the caller:
 *
 * - A Table's DROPDOWN validation lives on the Table's column properties, not
 *   on the cells. Anything looking for a dropdown has to read `sheets.tables`
 *   as well as cell validation or it will report a typed column as having none.
 * - `appendCells` with a `tableId` returns success and writes an empty row. Row
 *   values go in through `values.append`, which is `sheets_write`'s job, not
 *   this file's.
 * - A cell that a person filled by hand keeps its fill and overrides the band
 *   color, so adopting a Table over hand-colored data looks patchy. `adopt`
 *   reports those cells rather than quietly clearing them.
 */

import { columnIndexToLetter, type GridRange } from "./a1.js";
import {
  METADATA_KEYS,
  type ColumnMetadata,
  type ColumnRole,
  type SheetMetadata,
} from "./contract.js";
import { GsheetsError } from "./errors.js";
import type { Owner } from "./registry.js";
import { STATUS_ROLES, type StatusRole } from "./tablecolors.js";

/**
 * The column types the API accepts, minus the unspecified member. Verified
 * against the discovery document, revision 20260831.
 */
export const TABLE_COLUMN_TYPES = [
  "DOUBLE",
  "CURRENCY",
  "PERCENT",
  "DATE",
  "TIME",
  "DATE_TIME",
  "TEXT",
  "BOOLEAN",
  "DROPDOWN",
  "FILES_CHIP",
  "PEOPLE_CHIP",
  "FINANCE_CHIP",
  "PLACE_CHIP",
  "RATINGS_CHIP",
] as const;

export type TableColumnType = (typeof TABLE_COLUMN_TYPES)[number];

export interface ColumnSpec {
  /** The header text, which is also the Table column's name. */
  name: string;
  type?: TableColumnType;
  /** Options for a DROPDOWN column. */
  options?: string[];
  /** A range the options come from, for a dropdown fed by a list elsewhere. */
  options_range?: string;
  /** A note on the header cell: what this column is for, in a sentence. */
  note?: string;
  /** The contract role, stored as developer metadata on the column. */
  role?: ColumnRole;
  /** Who owns the column. A column owned by a human is never written to. */
  owner?: Owner;
  /** A stable name for the column, so a renamed header does not orphan it. */
  key?: string;
}

export interface TableColumnProperties {
  columnIndex: number;
  columnName: string;
  columnType?: string;
  dataValidationRule?: { condition: { type: string; values?: Array<{ userEnteredValue: string }> } };
}

/** Build the Table's column properties from the caller's column specs. */
export function buildColumnProperties(columns: ColumnSpec[]): TableColumnProperties[] {
  return columns.map((column, index) => {
    const name = String(column.name ?? "").trim();
    if (!name) {
      throw new GsheetsError(
        "invalid_argument",
        `Column ${index + 1} has no name.`,
        "Every column needs a name, which becomes both the header text and the Table column's name.",
      );
    }
    const properties: TableColumnProperties = { columnIndex: index, columnName: name };
    if (column.type) {
      if (!(TABLE_COLUMN_TYPES as readonly string[]).includes(column.type)) {
        throw new GsheetsError(
          "invalid_argument",
          `"${column.type}" is not a Table column type.`,
          `The types are: ${TABLE_COLUMN_TYPES.join(", ")}.`,
        );
      }
      properties.columnType = column.type;
    }

    if (column.type === "DROPDOWN") {
      if (column.options?.length) {
        properties.dataValidationRule = {
          condition: {
            type: "ONE_OF_LIST",
            values: column.options.map((v) => ({ userEnteredValue: String(v) })),
          },
        };
      } else if (column.options_range) {
        const range = column.options_range.trim();
        properties.dataValidationRule = {
          condition: {
            type: "ONE_OF_RANGE",
            values: [{ userEnteredValue: range.startsWith("=") ? range : `=${range}` }],
          },
        };
      } else {
        throw new GsheetsError(
          "invalid_argument",
          `The DROPDOWN column "${name}" has no options.`,
          'Pass options, for example options: ["Confirmed", "Pending"], or options_range to point at a list elsewhere in the workbook.',
        );
      }
    } else if (column.options?.length || column.options_range) {
      throw new GsheetsError(
        "invalid_argument",
        `The column "${name}" has options but is typed ${column.type ?? "TEXT"}.`,
        "Options belong to a DROPDOWN column. Set type: DROPDOWN, or drop the options.",
      );
    }

    return properties;
  });
}

/**
 * A Table needs a bounded range: it has to know where its last row and column
 * are. An open ended reference like A:E would be accepted by A1 parsing and
 * then rejected by the API with a message about the grid, so it is caught here.
 */
export function requireBoundedRange(range: GridRange, reference: string): Required<GridRange> {
  const missing: string[] = [];
  if (range.startRowIndex === undefined) missing.push("a first row");
  if (range.endRowIndex === undefined) missing.push("a last row");
  if (range.startColumnIndex === undefined) missing.push("a first column");
  if (range.endColumnIndex === undefined) missing.push("a last column");
  if (missing.length) {
    throw new GsheetsError(
      "bad_range",
      `A Table needs a range with ${missing.join(" and ")}, and "${reference}" has none.`,
      "Give the whole block including the header row, for example A1:F40. A Table cannot cover an open ended range like A:F.",
    );
  }
  return range as Required<GridRange>;
}

/** The header row of a Table's range, as its own GridRange. */
export function headerRangeOf(range: Required<GridRange>): GridRange {
  return {
    sheetId: range.sheetId,
    startRowIndex: range.startRowIndex,
    endRowIndex: range.startRowIndex + 1,
    startColumnIndex: range.startColumnIndex,
    endColumnIndex: range.endColumnIndex,
  };
}

/** The data rows of a Table's range, header excluded. */
export function dataRangeOf(range: Required<GridRange>): GridRange {
  return {
    sheetId: range.sheetId,
    startRowIndex: range.startRowIndex + 1,
    endRowIndex: range.endRowIndex,
    startColumnIndex: range.startColumnIndex,
    endColumnIndex: range.endColumnIndex,
  };
}

/** One column of a Table's data rows, by position within the Table. */
export function columnRangeOf(range: Required<GridRange>, columnIndex: number): GridRange {
  const start = range.startColumnIndex + columnIndex;
  return {
    sheetId: range.sheetId,
    startRowIndex: range.startRowIndex + 1,
    endRowIndex: range.endRowIndex,
    startColumnIndex: start,
    endColumnIndex: start + 1,
  };
}

/** The sheet column letter for a Table column, which may not start at A. */
export function columnLetterOf(range: Required<GridRange>, columnIndex: number): string {
  return columnIndexToLetter(range.startColumnIndex + columnIndex);
}

// ---------------------------------------------------------------------------
// Contract metadata
// ---------------------------------------------------------------------------

/**
 * What the plugin records about one tab, stored as the `gsheets.sheet` entry.
 *
 * It extends the shared `SheetMetadata` with the things the Table and Settings
 * tools have to remember between runs: whether the plugin built this tab or
 * merely adopted somebody else's, where its block sits, and which status fills
 * it painted. The status fills are recorded by fingerprint rather than by
 * index, because a conditional format rule's index shifts whenever any rule is
 * added or deleted, and this record has to survive that.
 *
 * It rides the sheet rather than the spreadsheet so that a renamed tab keeps
 * its record, and so that a copy of the workbook keeps it too (spike 5).
 */
export interface PluginSheetRecord extends SheetMetadata {
  /** plugin: the plugin built this tab. adopted: it was somebody else's. */
  origin?: "plugin" | "adopted";
  table?: { name: string; range: string; tableId?: string };
  settings?: { range: string };
  statusFills?: Array<{ column: string; option: string; role: string; fingerprint: string }>;
}

/**
 * What the plugin records about one column, stored as the `gsheets.column`
 * entry: the shared contract fields, plus the provenance of a validation rule.
 *
 * Provenance is the point. A rule with no record beside it belongs to somebody
 * else, and rewriting it destroys chip colours the API cannot read back. So
 * when the plugin sets a rule it says so here, and on the next call it can tell
 * its own work from a colleague's rather than refusing to touch either.
 */
export interface PluginColumnRecord extends ColumnMetadata {
  /** Present when this plugin wrote the column's validation rule. */
  validation?: {
    /** The `sheets_validation` type behind it: list, checkbox, number, and so on. */
    kind: string;
    strict: boolean;
  };
}

/** How many columns one call will record provenance for. */
export const MAX_RECORDED_COLUMNS = 12;

export type MetadataLocation =
  | { spreadsheet: true }
  | { sheetId: number }
  | { dimensionRange: { sheetId: number; dimension: "COLUMNS"; startIndex: number; endIndex: number } };

export interface MetadataWrite {
  key: string;
  value: unknown;
  location: MetadataLocation;
  /** True when an entry with this key already sits at this location. */
  exists: boolean;
}

/**
 * Create or update one developer metadata entry.
 *
 * Visibility is PROJECT: the contract is the plugin's own bookkeeping, not
 * something every add-on that opens the file should read. Spike 5 confirmed
 * PROJECT metadata written on a column rides the column through an insert to
 * its left and survives `drive.files.copy` intact, so a duplicated tracker
 * keeps its contract.
 *
 * An update goes through a location lookup rather than a metadata id, because
 * the id is not knowable without a second read and the location is.
 */
export function metadataRequest(write: MetadataWrite): Record<string, unknown> {
  const metadataValue = typeof write.value === "string" ? write.value : JSON.stringify(write.value);
  const location = write.location as Record<string, unknown>;

  if (!write.exists) {
    return {
      createDeveloperMetadata: {
        developerMetadata: {
          metadataKey: write.key,
          metadataValue,
          location,
          visibility: "PROJECT",
        },
      },
    };
  }

  return {
    updateDeveloperMetadata: {
      dataFilters: [
        {
          developerMetadataLookup: {
            metadataKey: write.key,
            metadataLocation: location,
            locationMatchingStrategy: "EXACT_LOCATION",
            visibility: "PROJECT",
          },
        },
      ],
      developerMetadata: { metadataKey: write.key, metadataValue },
      fields: "metadataValue",
    },
  };
}

export interface ColumnMetadataInput {
  sheetId: number;
  /** Absolute column index in the sheet, not the index within the Table. */
  columnIndex: number;
  column: ColumnSpec;
  type?: string;
  exists: boolean;
}

/** The `gsheets.column` entry for one column of a Table. */
export function columnMetadataWrite(input: ColumnMetadataInput): MetadataWrite {
  const value: ColumnMetadata = { header: input.column.name };
  if (input.column.key) value.name = input.column.key;
  if (input.column.role) value.role = input.column.role;
  if (input.column.owner) value.owner = input.column.owner;
  const type = input.type ?? input.column.type;
  if (type) value.type = type;

  return {
    key: METADATA_KEYS.column,
    value,
    location: {
      dimensionRange: {
        sheetId: input.sheetId,
        dimension: "COLUMNS",
        startIndex: input.columnIndex,
        endIndex: input.columnIndex + 1,
      },
    },
    exists: input.exists,
  };
}

// ---------------------------------------------------------------------------
// Status fills: the chip colors the API cannot set
// ---------------------------------------------------------------------------

/**
 * Which role a status option should be painted in, or nothing.
 *
 * The API has no color field on any validation rule, so a dropdown's chips can
 * only be colored by hand in the UI. Where a person would reach for chips, the
 * plugin paints the same meaning with conditional format rules, and this is the
 * reading of what each option means. It is a guess made explicit: every rule it
 * produces is reported back by name so a wrong one is visible.
 *
 * An option this does not recognise gets `undefined`, and no rule at all. It
 * used to get `muted`, which painted every unfamiliar status in a colour that
 * asserted something the plugin did not know. A status with no recognised
 * meaning has no colour: an unpainted row reads as "no state claimed", which
 * is the truth, and a five-option dropdown does not end up in five colours
 * three of which mean nothing. `muted` is still available as an explicit
 * override for a status genuinely meant to look inactive.
 */
export function defaultStatusRole(option: string): StatusRole | undefined {
  const text = String(option ?? "").trim().toLowerCase();
  if (/^(confirmed|complete|completed|done|approved|paid|signed|yes|active|enrolled|received|ok)\b/.test(text)) {
    return "ok";
  }
  if (/^(pending|in progress|in review|waiting|waitlist|sent|requested|scheduled|draft|maybe|hold|on hold|tentative)\b/.test(text)) {
    return "warn";
  }
  if (/^(declined|cancelled|canceled|overdue|late|blocked|failed|rejected|no|dropped|missing|expired)\b/.test(text)) {
    return "flag";
  }
  return undefined;
}

export interface StatusFillSpec {
  option: string;
  role: StatusRole;
}

/**
 * Pair each dropdown option with the role that paints it.
 *
 * Options with no recognised meaning are dropped rather than given a colour,
 * so the caller generates no rule for them. Name one in `overrides` to paint
 * it anyway.
 */
export function statusFillSpecs(
  options: string[],
  overrides: Record<string, string> = {},
): StatusFillSpec[] {
  return options.flatMap((option) => {
    const override = overrides[option] ?? overrides[option.toLowerCase()];
    if (override) {
      if (!(STATUS_ROLES as readonly string[]).includes(override)) {
        throw new GsheetsError(
          "invalid_argument",
          `"${override}" is not a status role.`,
          `The status roles are: ${STATUS_ROLES.join(", ")}.`,
        );
      }
      return [{ option, role: override as StatusRole }];
    }
    const role = defaultStatusRole(option);
    return role ? [{ option, role }] : [];
  });
}

export interface StatusFillGate {
  allowed: boolean;
  reason?: string;
}

/**
 * May this sheet carry plugin owned status fills?
 *
 * Only sheets the plugin created. On a sheet a person built, a set of
 * conditional rules the plugin can later rewrite is a set of rules that will
 * one day overwrite the person's own. The gate reads the sheet's own metadata
 * rather than trusting the call, so it holds across sessions and clients.
 */
export function statusFillGate(input: {
  origin?: string;
  creatingNow?: boolean;
  registryOwner?: Owner;
  existingRuleCount?: number;
}): StatusFillGate {
  if (input.registryOwner === "human" || input.registryOwner === "shared") {
    return {
      allowed: false,
      reason: `The registry says this spreadsheet is ${input.registryOwner} owned, so the plugin does not paint status fills on it. Ask for them by hand, or change the registry entry.`,
    };
  }
  if (input.origin === "plugin") return { allowed: true };
  if (input.origin === "adopted") {
    return {
      allowed: false,
      reason:
        "This Table was adopted from a sheet somebody else built, so its conditional formats are theirs. Status fills are only painted on sheets the plugin created.",
    };
  }
  if (input.creatingNow) {
    if ((input.existingRuleCount ?? 0) > 0) {
      return {
        allowed: false,
        reason: `This tab already carries ${input.existingRuleCount} conditional format rule(s) that the plugin did not write, so it is somebody else's sheet. Status fills are only painted on sheets the plugin created.`,
      };
    }
    return { allowed: true };
  }
  return {
    allowed: false,
    reason:
      "This tab carries no plugin metadata, so there is no evidence the plugin created it. Status fills are only painted on sheets the plugin created.",
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** "Instructors covers A1:E12, 5 columns, 11 data rows." */
export function describeTableRange(name: string, range: Required<GridRange>, a1: string): string {
  const columns = range.endColumnIndex - range.startColumnIndex;
  const rows = Math.max(0, range.endRowIndex - range.startRowIndex - 1);
  return `${name} covers ${a1}: ${columns} column${columns === 1 ? "" : "s"}, ${rows} data row${rows === 1 ? "" : "s"}.`;
}
