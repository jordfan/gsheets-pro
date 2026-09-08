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

import { withRetry } from "./batch.js";
import {
  METADATA_KEYS,
  readColumnMetadata,
  readManifest,
  readSheetMetadata,
  toMetadataEntries,
  type ColumnMetadata,
  type ManifestMetadata,
  type MetadataEntry,
  type SheetMetadata,
} from "./contract.js";
import { loadPreset, DEFAULT_PRESET, type Preset } from "./tablecolors.js";

export interface MetadataSnapshot {
  entries: MetadataEntry[];
  manifest?: ManifestMetadata;
  /** False when the search failed, which is information rather than an error. */
  readable: boolean;
  note?: string;
}

interface MetadataCapableSheets {
  spreadsheets: {
    developerMetadata: { search(params: unknown): Promise<{ data: unknown }> };
  };
}

/** Every `gsheets.*` metadata entry on a spreadsheet, in one call. */
export async function readMetadata(
  api: MetadataCapableSheets,
  spreadsheetId: string,
): Promise<MetadataSnapshot> {
  try {
    const search = await withRetry(() =>
      api.spreadsheets.developerMetadata.search({
        spreadsheetId,
        requestBody: { dataFilters: [{ developerMetadataLookup: {} }] },
      }),
    );
    const matched =
      (search.data as { matchedDeveloperMetadata?: Array<{ developerMetadata?: unknown }> })
        .matchedDeveloperMetadata ?? [];
    const entries = toMetadataEntries(
      matched.flatMap((m) => (m.developerMetadata ? [m.developerMetadata as never] : [])),
    );
    const snapshot: MetadataSnapshot = { entries, readable: true };
    const manifest = readManifest(entries);
    if (manifest) snapshot.manifest = manifest;
    return snapshot;
  } catch (error) {
    return {
      entries: [],
      readable: false,
      note: `Developer metadata could not be read (${(error as Error).message}). Treating this spreadsheet as carrying no contract.`,
    };
  }
}

/** The sheet level record, when the plugin wrote one for this tab. */
export function sheetRecord(snapshot: MetadataSnapshot, sheetId: number): SheetMetadata | undefined {
  return readSheetMetadata(snapshot.entries, sheetId);
}

/** The column records for one tab, keyed by zero based column index. */
export function columnRecords(
  snapshot: MetadataSnapshot,
  sheetId: number,
): Map<number, ColumnMetadata> {
  return readColumnMetadata(snapshot.entries, sheetId);
}

/** True when a `gsheets.column` entry already sits on this exact column. */
export function hasColumnRecord(
  snapshot: MetadataSnapshot,
  sheetId: number,
  columnIndex: number,
): boolean {
  return snapshot.entries.some(
    (e) =>
      e.key === METADATA_KEYS.column &&
      e.scope === "COLUMN" &&
      e.dimension?.sheetId === sheetId &&
      e.dimension.index === columnIndex,
  );
}

export function hasSheetRecord(snapshot: MetadataSnapshot, sheetId: number): boolean {
  return snapshot.entries.some(
    (e) => e.key === METADATA_KEYS.sheet && e.scope === "SHEET" && e.sheetId === sheetId,
  );
}

export function hasManifest(snapshot: MetadataSnapshot): boolean {
  return snapshot.entries.some((e) => e.key === METADATA_KEYS.manifest && e.scope === "SPREADSHEET");
}

/**
 * Which preset to paint with: what the caller said, else what the tab was
 * built with, else what the workbook was built with, else the default. Asking
 * the sheet first is what keeps a second Table on a `park` workbook from
 * arriving in `neutral` colors.
 */
export function presetFor(
  snapshot: MetadataSnapshot,
  sheetId: number | undefined,
  override?: string,
): Preset {
  if (override?.trim()) return loadPreset(override.trim());
  const fromSheet = sheetId === undefined ? undefined : sheetRecord(snapshot, sheetId)?.preset;
  return loadPreset(fromSheet ?? snapshot.manifest?.preset ?? DEFAULT_PRESET);
}
