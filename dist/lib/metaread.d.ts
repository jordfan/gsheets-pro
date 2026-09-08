/**
 * Reading the contract back off a spreadsheet.
 *
 * Developer metadata is where the plugin records what it built: which preset a
 * sheet was painted with, which columns carry which role, and whether the sheet
 * is the plugin's own work or somebody else's that it was asked to adopt. Spike
 * 5 settled how to read it: `developerMetadata.search` returns all three
 * location types in one call, where a masked `spreadsheets.get` needs a
 * different field path for each and a `ranges` argument for the column one.
 *
 * A sheet a person built carries none of this, which is the common case and not
 * an error. Every function here answers "nothing found" rather than throwing,
 * because a tool that refuses to run on an ordinary spreadsheet is useless.
 */
import { type ColumnMetadata, type ManifestMetadata, type MetadataEntry, type SheetMetadata } from "./contract.js";
import { type Preset } from "./tablecolors.js";
export interface MetadataSnapshot {
    entries: MetadataEntry[];
    manifest?: ManifestMetadata;
    /** False when the search failed, which is information rather than an error. */
    readable: boolean;
    note?: string;
}
interface MetadataCapableSheets {
    spreadsheets: {
        developerMetadata: {
            search(params: unknown): Promise<{
                data: unknown;
            }>;
        };
    };
}
/** Every `gsheets.*` metadata entry on a spreadsheet, in one call. */
export declare function readMetadata(api: MetadataCapableSheets, spreadsheetId: string): Promise<MetadataSnapshot>;
/** The sheet level record, when the plugin wrote one for this tab. */
export declare function sheetRecord(snapshot: MetadataSnapshot, sheetId: number): SheetMetadata | undefined;
/** The column records for one tab, keyed by zero based column index. */
export declare function columnRecords(snapshot: MetadataSnapshot, sheetId: number): Map<number, ColumnMetadata>;
/** True when a `gsheets.column` entry already sits on this exact column. */
export declare function hasColumnRecord(snapshot: MetadataSnapshot, sheetId: number, columnIndex: number): boolean;
export declare function hasSheetRecord(snapshot: MetadataSnapshot, sheetId: number): boolean;
export declare function hasManifest(snapshot: MetadataSnapshot): boolean;
/**
 * Which preset to paint with: what the caller said, else what the tab was
 * built with, else what the workbook was built with, else the default. Asking
 * the sheet first is what keeps a second Table on a `park` workbook from
 * arriving in `neutral` colors.
 */
export declare function presetFor(snapshot: MetadataSnapshot, sheetId: number | undefined, override?: string): Preset;
export {};
//# sourceMappingURL=metaread.d.ts.map