/**
 * The contract: what this spreadsheet expects of whoever writes to it.
 *
 * Three sources, in decreasing order of confidence.
 *
 * 1. The repo registry. A person wrote it down. It wins.
 * 2. Developer metadata the plugin wrote when it built or adopted the sheet.
 *    Column metadata rides the dimension, so it survives inserts and moves; a
 *    header renamed underneath it shows up as drift rather than as silence.
 * 3. Inference from the sheet itself. This is a reading, not an authority, and
 *    `sheets_open` labels it as such. Guessing a contract and then enforcing it
 *    would be worse than having none, so inference only ever produces advice.
 *
 * When there is no registry entry and no metadata, the honest answer is "no
 * contract", and that is what we say.
 */
import { type Owner, type Policy } from "./registry.js";
export declare const METADATA_KEYS: {
    readonly manifest: "gsheets.manifest";
    readonly sheet: "gsheets.sheet";
    readonly column: "gsheets.column";
};
export type ColumnRole = "key" | "input" | "formula" | "status" | "log" | "check";
export declare const COLUMN_ROLES: readonly ColumnRole[];
/** What the plugin stores in a `gsheets.column` metadata value. */
export interface ColumnMetadata {
    /** A stable name, so a renamed header does not orphan the contract. */
    name?: string;
    /** The header text as it was when the metadata was written. */
    header?: string;
    role?: ColumnRole;
    owner?: Owner;
    /** The Table column type, when the sheet has one. */
    type?: string;
}
export interface SheetMetadata {
    archetype?: "tracker" | "model";
    preset?: string;
    headerRow?: number;
    keyColumn?: string;
}
export interface ManifestMetadata {
    version?: number;
    preset?: string;
    archetype?: "tracker" | "model";
    createdBy?: string;
    createdAt?: string;
}
/** One developer metadata entry, flattened out of the API's shape. */
export interface MetadataEntry {
    key: string;
    value: string;
    /** Present when the metadata rides a column or a row. */
    dimension?: {
        sheetId: number;
        type: "COLUMNS" | "ROWS";
        index: number;
    };
    sheetId?: number;
    scope: "SPREADSHEET" | "SHEET" | "COLUMN" | "ROW";
}
export interface ContractColumn {
    letter: string;
    index: number;
    header?: string;
    name?: string;
    role?: ColumnRole;
    owner?: Owner;
    type?: string;
    writable: boolean;
    /** Set when the column's header no longer matches what metadata recorded. */
    drift?: string;
}
export interface SheetContract {
    sheet: string;
    /** Which sources actually contributed. "none" means say so out loud. */
    source: "registry" | "metadata" | "registry+metadata" | "none";
    owner?: Owner;
    positionalRows: boolean;
    colleagueSafeText: boolean;
    columns: ContractColumn[];
    archetype?: "tracker" | "model";
    preset?: string;
    headerRow?: number;
    keyColumn?: string;
    /** Human readable, one line, for the prose half of a tool response. */
    summary: string;
    drift: string[];
    registryPath?: string;
}
/** Flatten `spreadsheets.developerMetadata.search` results into our shape. */
export declare function toMetadataEntries(raw: Array<{
    metadataKey?: string | null;
    metadataValue?: string | null;
    location?: {
        locationType?: string | null;
        sheetId?: number | null;
        dimensionRange?: {
            sheetId?: number | null;
            dimension?: string | null;
            startIndex?: number | null;
        } | null;
    } | null;
}>): MetadataEntry[];
export declare function readManifest(entries: MetadataEntry[]): ManifestMetadata | undefined;
export declare function readSheetMetadata(entries: MetadataEntry[], sheetId: number): SheetMetadata | undefined;
/** Column metadata for one tab, keyed by zero based column index. */
export declare function readColumnMetadata(entries: MetadataEntry[], sheetId: number): Map<number, ColumnMetadata>;
export interface BuildContractInput {
    sheet: string;
    /** The header row as read, left to right. */
    headers?: string[];
    policy?: Policy;
    columnMetadata?: Map<number, ColumnMetadata>;
    sheetMetadata?: SheetMetadata;
    manifest?: ManifestMetadata;
}
export declare function buildContract(input: BuildContractInput): SheetContract;
export interface InferenceInput {
    /** First rows of the tab, values as displayed. */
    rows: string[][];
    frozenRowCount?: number;
    frozenColumnCount?: number;
    /** Number formats of the first data row, by column, when known. */
    numberFormats?: Array<string | undefined>;
    hasBanding?: boolean;
    hasFilter?: boolean;
}
export interface InferredConventions {
    /** One based row number, or undefined when no row reads like a header. */
    headerRow?: number;
    headers: string[];
    /** One based row where data starts. */
    firstDataRow?: number;
    /** Column letter whose values are unique and complete. */
    keyColumn?: string;
    /** True when a blank row splits the tab into more than one block. */
    multipleBlocks: boolean;
    frozenHeader: boolean;
    banded: boolean;
    filtered: boolean;
    notes: string[];
}
/**
 * Read the tab the way a person would: find the header row, notice whether the
 * first column is a key, notice whether the tab is one block or several.
 */
export declare function inferConventions(input: InferenceInput): InferredConventions;
export interface ValidationSummary {
    /** Column letter the rule sits on, when it covers exactly one column. */
    column?: string;
    range: string;
    conditionType?: string;
    values: string[];
    strict: boolean;
    /** True when the plugin did not create this rule. */
    uiOwned: boolean;
    note?: string;
}
/**
 * Decide whether a dropdown belongs to the UI.
 *
 * The API has no colour field on a validation rule, so the chip colours a
 * person picked in the UI cannot be read and cannot be written back. Rewriting
 * such a rule with an identical condition still discards them. So any rule the
 * plugin did not create is treated as the human's, reported rather than
 * touched, and changed only with `force`.
 */
export declare function markUiOwned(rules: Array<Omit<ValidationSummary, "uiOwned" | "note">>, pluginColumns: Set<number>, letterToIndex: (letter: string) => number): ValidationSummary[];
//# sourceMappingURL=contract.d.ts.map