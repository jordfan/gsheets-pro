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

import { columnIndexToLetter } from "./a1.js";
import {
  describePolicy,
  isColumnWritable,
  type Owner,
  type Policy,
} from "./registry.js";

export const METADATA_KEYS = {
  manifest: "gsheets.manifest",
  sheet: "gsheets.sheet",
  column: "gsheets.column",
} as const;

export type ColumnRole = "key" | "input" | "formula" | "status" | "log" | "check";

export const COLUMN_ROLES: readonly ColumnRole[] = [
  "key",
  "input",
  "formula",
  "status",
  "log",
  "check",
];

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
  dimension?: { sheetId: number; type: "COLUMNS" | "ROWS"; index: number };
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

// ---------------------------------------------------------------------------
// Reading metadata
// ---------------------------------------------------------------------------

function parseJsonValue<T>(value: string): T | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as T) : undefined;
  } catch {
    return undefined;
  }
}

/** Flatten `spreadsheets.developerMetadata.search` results into our shape. */
export function toMetadataEntries(
  raw: Array<{
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
  }>,
): MetadataEntry[] {
  const out: MetadataEntry[] = [];
  for (const item of raw) {
    const key = item.metadataKey;
    const value = item.metadataValue;
    if (!key || value === undefined || value === null) continue;
    const location = item.location ?? {};
    const dimensionRange = location.dimensionRange;
    if (dimensionRange && dimensionRange.sheetId !== undefined && dimensionRange.sheetId !== null) {
      const type = dimensionRange.dimension === "ROWS" ? "ROWS" : "COLUMNS";
      out.push({
        key,
        value,
        scope: type === "ROWS" ? "ROW" : "COLUMN",
        sheetId: dimensionRange.sheetId,
        dimension: {
          sheetId: dimensionRange.sheetId,
          type,
          index: dimensionRange.startIndex ?? 0,
        },
      });
      continue;
    }
    if (location.sheetId !== undefined && location.sheetId !== null) {
      out.push({ key, value, scope: "SHEET", sheetId: location.sheetId });
      continue;
    }
    out.push({ key, value, scope: "SPREADSHEET" });
  }
  return out;
}

export function readManifest(entries: MetadataEntry[]): ManifestMetadata | undefined {
  const hit = entries.find((e) => e.key === METADATA_KEYS.manifest && e.scope === "SPREADSHEET");
  return hit ? parseJsonValue<ManifestMetadata>(hit.value) : undefined;
}

export function readSheetMetadata(
  entries: MetadataEntry[],
  sheetId: number,
): SheetMetadata | undefined {
  const hit = entries.find(
    (e) => e.key === METADATA_KEYS.sheet && e.scope === "SHEET" && e.sheetId === sheetId,
  );
  return hit ? parseJsonValue<SheetMetadata>(hit.value) : undefined;
}

/** Column metadata for one tab, keyed by zero based column index. */
export function readColumnMetadata(
  entries: MetadataEntry[],
  sheetId: number,
): Map<number, ColumnMetadata> {
  const out = new Map<number, ColumnMetadata>();
  for (const entry of entries) {
    if (entry.key !== METADATA_KEYS.column) continue;
    if (entry.scope !== "COLUMN" || entry.dimension?.sheetId !== sheetId) continue;
    const parsed = parseJsonValue<ColumnMetadata>(entry.value);
    if (parsed) out.set(entry.dimension.index, parsed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Building the contract
// ---------------------------------------------------------------------------

export interface BuildContractInput {
  sheet: string;
  /** The header row as read, left to right. */
  headers?: string[];
  policy?: Policy;
  columnMetadata?: Map<number, ColumnMetadata>;
  sheetMetadata?: SheetMetadata;
  manifest?: ManifestMetadata;
}

export function buildContract(input: BuildContractInput): SheetContract {
  const { sheet, policy, sheetMetadata, manifest } = input;
  const headers = input.headers ?? [];
  const columnMetadata = input.columnMetadata ?? new Map<number, ColumnMetadata>();

  const hasMetadata = columnMetadata.size > 0 || sheetMetadata !== undefined;
  const source: SheetContract["source"] =
    policy && hasMetadata
      ? "registry+metadata"
      : policy
        ? "registry"
        : hasMetadata
          ? "metadata"
          : "none";

  const width = Math.max(headers.length, ...[...columnMetadata.keys()].map((i) => i + 1), 0);
  const columns: ContractColumn[] = [];
  const drift: string[] = [];

  for (let index = 0; index < width; index += 1) {
    const letter = columnIndexToLetter(index);
    const header = headers[index]?.trim() || undefined;
    const meta = columnMetadata.get(index);
    const writability = isColumnWritable(policy, { letter, header });

    const column: ContractColumn = {
      letter,
      index,
      writable: writability.writable,
    };
    if (header) column.header = header;
    if (meta?.name) column.name = meta.name;
    if (meta?.role) column.role = meta.role;
    if (meta?.owner) column.owner = meta.owner;
    if (meta?.type) column.type = meta.type;

    if (meta?.header && header && meta.header !== header) {
      column.drift = `header is now "${header}", metadata recorded "${meta.header}"`;
      drift.push(`Column ${letter}: ${column.drift}.`);
    }
    columns.push(column);
  }

  const contract: SheetContract = {
    sheet,
    source,
    positionalRows: policy?.positionalRows === true,
    colleagueSafeText: policy?.colleagueSafeText === true,
    columns,
    drift,
    summary: "",
  };
  if (policy?.owner) contract.owner = policy.owner;
  if (policy?.path) contract.registryPath = policy.path;
  const archetype = sheetMetadata?.archetype ?? manifest?.archetype;
  if (archetype) contract.archetype = archetype;
  const preset = sheetMetadata?.preset ?? manifest?.preset;
  if (preset) contract.preset = preset;
  if (sheetMetadata?.headerRow) contract.headerRow = sheetMetadata.headerRow;
  if (sheetMetadata?.keyColumn) contract.keyColumn = sheetMetadata.keyColumn;

  contract.summary = summarize(contract, policy);
  return contract;
}

function summarize(contract: SheetContract, policy?: Policy): string {
  if (contract.source === "none") {
    return "No contract. This spreadsheet has no registry entry and no plugin metadata, so nothing here is protected beyond the formula guard. Treat every column as someone else's until told otherwise.";
  }
  const parts: string[] = [];
  if (policy) parts.push(`Registry (${describePolicy(policy)})`);
  if (contract.source !== "registry") {
    const locked = contract.columns.filter((c) => !c.writable).map((c) => c.letter);
    const roles = contract.columns.filter((c) => c.role).length;
    const bits: string[] = [];
    if (roles) bits.push(`${roles} of ${contract.columns.length} columns carry a role`);
    if (locked.length) bits.push(`columns ${locked.join(", ")} are not ours`);
    if (contract.archetype) bits.push(`archetype ${contract.archetype}`);
    parts.push(`Metadata (${bits.join("; ") || "present"})`);
  }
  if (contract.drift.length) parts.push(`${contract.drift.length} drift note(s)`);
  return parts.join(". ") + ".";
}

// ---------------------------------------------------------------------------
// Inference, which is advice and never enforcement
// ---------------------------------------------------------------------------

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

const looksNumeric = (v: string) => v !== "" && Number.isFinite(Number(v.replace(/[$,%\s]/g, "")));

/**
 * Read the tab the way a person would: find the header row, notice whether the
 * first column is a key, notice whether the tab is one block or several.
 */
export function inferConventions(input: InferenceInput): InferredConventions {
  const rows = input.rows ?? [];
  const notes: string[] = [];

  let headerIndex: number | undefined;
  if (input.frozenRowCount && input.frozenRowCount > 0) {
    headerIndex = input.frozenRowCount - 1;
  } else {
    for (let i = 0; i < Math.min(rows.length, 10); i += 1) {
      const row = rows[i] ?? [];
      const filled = row.filter((c) => String(c ?? "").trim() !== "");
      if (filled.length < 2) continue;
      if (filled.every((c) => !looksNumeric(String(c)))) {
        headerIndex = i;
        break;
      }
    }
  }

  const headers =
    headerIndex !== undefined
      ? (rows[headerIndex] ?? []).map((c) => String(c ?? "").trim())
      : [];
  const firstDataIndex = headerIndex !== undefined ? headerIndex + 1 : 0;
  const dataRows = rows.slice(firstDataIndex).filter((r) => r.some((c) => String(c ?? "").trim()));

  // A blank row between filled rows means the tab holds more than one block,
  // which is the single most common reason an append lands in the wrong place.
  let multipleBlocks = false;
  let sawData = false;
  let sawGap = false;
  for (let i = firstDataIndex; i < rows.length; i += 1) {
    const filled = (rows[i] ?? []).some((c) => String(c ?? "").trim() !== "");
    if (filled) {
      if (sawData && sawGap) {
        multipleBlocks = true;
        break;
      }
      sawData = true;
    } else if (sawData) {
      sawGap = true;
    }
  }
  if (multipleBlocks) {
    notes.push(
      "A blank row separates two blocks of data on this tab, so an append has to land at the end of the first block rather than at the end of the sheet.",
    );
  }

  let keyColumn: string | undefined;
  const width = Math.max(headers.length, ...dataRows.map((r) => r.length), 0);
  for (let col = 0; col < Math.min(width, 8); col += 1) {
    const values = dataRows.map((r) => String(r[col] ?? "").trim());
    if (values.length === 0) break;
    if (values.some((v) => v === "")) continue;
    if (new Set(values.map((v) => v.toLowerCase())).size !== values.length) continue;
    keyColumn = columnIndexToLetter(col);
    break;
  }
  if (!keyColumn && dataRows.length > 0) {
    notes.push(
      "No column has a complete and unique value in every row, so there is no obvious key to match rows on. An upsert needs one.",
    );
  }

  const result: InferredConventions = {
    headers,
    multipleBlocks,
    frozenHeader: (input.frozenRowCount ?? 0) > 0,
    banded: input.hasBanding === true,
    filtered: input.hasFilter === true,
    notes,
  };
  if (headerIndex !== undefined) {
    result.headerRow = headerIndex + 1;
    result.firstDataRow = headerIndex + 2;
  }
  if (keyColumn) result.keyColumn = keyColumn;
  if (!result.frozenHeader && headerIndex !== undefined) {
    notes.push(
      "The header row is not frozen, so it scrolls out of view. Freezing it is one call and is what a person would have done.",
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// UI owned validation rules
// ---------------------------------------------------------------------------

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
export function markUiOwned(
  rules: Array<Omit<ValidationSummary, "uiOwned" | "note">>,
  pluginColumns: Set<number>,
  letterToIndex: (letter: string) => number,
): ValidationSummary[] {
  return rules.map((rule) => {
    const index = rule.column ? safeIndex(rule.column, letterToIndex) : undefined;
    const uiOwned = index === undefined || !pluginColumns.has(index);
    const out: ValidationSummary = { ...rule, uiOwned };
    if (uiOwned) {
      out.note =
        "Set in the Sheets UI, or by someone else. Its chip colours cannot be read through the API and would be lost on a rewrite, so it is left alone unless you pass force.";
    }
    return out;
  });
}

function safeIndex(letter: string, letterToIndex: (letter: string) => number): number | undefined {
  try {
    return letterToIndex(letter);
  } catch {
    return undefined;
  }
}
