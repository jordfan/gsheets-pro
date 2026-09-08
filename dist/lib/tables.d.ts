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
import { type GridRange } from "./a1.js";
import { type ColumnMetadata, type ColumnRole, type SheetMetadata } from "./contract.js";
import type { Owner } from "./registry.js";
import { type StatusRole } from "./tablecolors.js";
/**
 * The column types the API accepts, minus the unspecified member. Verified
 * against the discovery document, revision 20260831.
 */
export declare const TABLE_COLUMN_TYPES: readonly ["DOUBLE", "CURRENCY", "PERCENT", "DATE", "TIME", "DATE_TIME", "TEXT", "BOOLEAN", "DROPDOWN", "FILES_CHIP", "PEOPLE_CHIP", "FINANCE_CHIP", "PLACE_CHIP", "RATINGS_CHIP"];
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
    dataValidationRule?: {
        condition: {
            type: string;
            values?: Array<{
                userEnteredValue: string;
            }>;
        };
    };
}
/** Build the Table's column properties from the caller's column specs. */
export declare function buildColumnProperties(columns: ColumnSpec[]): TableColumnProperties[];
/**
 * A Table needs a bounded range: it has to know where its last row and column
 * are. An open ended reference like A:E would be accepted by A1 parsing and
 * then rejected by the API with a message about the grid, so it is caught here.
 */
export declare function requireBoundedRange(range: GridRange, reference: string): Required<GridRange>;
/** The header row of a Table's range, as its own GridRange. */
export declare function headerRangeOf(range: Required<GridRange>): GridRange;
/** The data rows of a Table's range, header excluded. */
export declare function dataRangeOf(range: Required<GridRange>): GridRange;
/** One column of a Table's data rows, by position within the Table. */
export declare function columnRangeOf(range: Required<GridRange>, columnIndex: number): GridRange;
/** The sheet column letter for a Table column, which may not start at A. */
export declare function columnLetterOf(range: Required<GridRange>, columnIndex: number): string;
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
    table?: {
        name: string;
        range: string;
        tableId?: string;
    };
    settings?: {
        range: string;
    };
    statusFills?: Array<{
        column: string;
        option: string;
        role: string;
        fingerprint: string;
    }>;
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
export declare const MAX_RECORDED_COLUMNS = 12;
export type MetadataLocation = {
    spreadsheet: true;
} | {
    sheetId: number;
} | {
    dimensionRange: {
        sheetId: number;
        dimension: "COLUMNS";
        startIndex: number;
        endIndex: number;
    };
};
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
export declare function metadataRequest(write: MetadataWrite): Record<string, unknown>;
export interface ColumnMetadataInput {
    sheetId: number;
    /** Absolute column index in the sheet, not the index within the Table. */
    columnIndex: number;
    column: ColumnSpec;
    type?: string;
    exists: boolean;
}
/** The `gsheets.column` entry for one column of a Table. */
export declare function columnMetadataWrite(input: ColumnMetadataInput): MetadataWrite;
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
export declare function defaultStatusRole(option: string): StatusRole | undefined;
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
export declare function statusFillSpecs(options: string[], overrides?: Record<string, string>): StatusFillSpec[];
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
export declare function statusFillGate(input: {
    origin?: string;
    creatingNow?: boolean;
    registryOwner?: Owner;
    existingRuleCount?: number;
}): StatusFillGate;
/** "Instructors covers A1:E12, 5 columns, 11 data rows." */
export declare function describeTableRange(name: string, range: Required<GridRange>, a1: string): string;
//# sourceMappingURL=tables.d.ts.map