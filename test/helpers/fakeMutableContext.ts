/**
 * A fake Sheets client that also accepts writes, so the Table, Settings,
 * validation and conditional format handlers can be exercised offline.
 *
 * It records every batchUpdate rather than applying it: these tools are judged
 * on the requests they assemble, and asserting on those is both stricter and
 * clearer than asserting on a simulated spreadsheet. The reads it answers are
 * real enough to drive the decisions the tools make, which is what the fills,
 * validation, tables and metadata below are for.
 *
 * Every id and name here is invented.
 */

import type { Context } from "../../src/lib/client.js";
import { SheetCache, type SheetInfo } from "../../src/lib/sheetcache.js";
import { parseRegistry, type Registry } from "../../src/lib/registry.js";
import { splitSheetRange } from "../../src/lib/a1.js";

export const FAKE_ID = "1MuTaBlEfAkEsPrEaDsHeEtIdAbCdEfGhIjKlMnOp";

export interface FakeCell {
  value?: string;
  note?: string;
  /** A fill set on the cell itself, which is what "somebody coloured this" looks like. */
  fill?: string;
  validation?: { type: string; values: string[] };
}

export interface FakeTab {
  title: string;
  sheetId: number;
  frozenRowCount?: number;
  rowCount?: number;
  columnCount?: number;
  /** Row major from A1. A plain string is a value; an object carries more. */
  cells?: Array<Array<string | FakeCell | null>>;
  tables?: Array<{
    tableId: string;
    name?: string;
    range?: Record<string, number>;
    columnProperties?: Array<{
      columnIndex?: number;
      columnName?: string;
      columnType?: string;
      dataValidationRule?: { condition: { type: string; values?: Array<{ userEnteredValue: string }> } };
    }>;
  }>;
  protectedRanges?: unknown[];
  conditionalFormats?: unknown[];
  basicFilter?: { tableId?: string };
}

export interface FakeWorkbook {
  title?: string;
  tabs: FakeTab[];
  namedRanges?: Array<{ namedRangeId: string; name: string; range: Record<string, number> }>;
  developerMetadata?: Array<{
    metadataKey: string;
    metadataValue: string;
    location: Record<string, unknown>;
  }>;
  metadataThrows?: boolean;
  /** Replies handed back for an addTable request, in order. */
  newTableIds?: string[];
}

export interface FakeCalls {
  get: Array<Record<string, unknown>>;
  batchUpdate: Array<{ requests: unknown[] }>;
  metadataSearch: unknown[];
}

function toCell(raw: string | FakeCell | null | undefined): FakeCell {
  if (raw === null || raw === undefined) return {};
  return typeof raw === "string" ? { value: raw } : raw;
}

function cellData(cell: FakeCell): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (cell.value !== undefined) out["formattedValue"] = cell.value;
  if (cell.note) out["note"] = cell.note;
  if (cell.fill) {
    out["userEnteredFormat"] = { backgroundColorStyle: { rgbColor: { red: 0.9, green: 0.8, blue: 1 } } };
  }
  if (cell.validation) {
    out["dataValidation"] = {
      condition: {
        type: cell.validation.type,
        values: cell.validation.values.map((v) => ({ userEnteredValue: v })),
      },
      strict: true,
    };
  }
  return out;
}

function bounds(range: string | undefined) {
  if (!range) return undefined;
  const m = /^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/.exec(range.toUpperCase());
  if (!m) return undefined;
  const toIndex = (letters: string) => {
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  return {
    startColumn: toIndex(m[1]),
    startRow: m[2] ? Number(m[2]) - 1 : 0,
    endColumn: m[3] ? toIndex(m[3]) : toIndex(m[1]),
    endRow: m[4] ? Number(m[4]) - 1 : undefined,
  };
}

export function makeMutableContext(
  workbook: FakeWorkbook,
  registryJson?: string,
): { context: Context; calls: FakeCalls; requests: () => unknown[] } {
  const calls: FakeCalls = { get: [], batchUpdate: [], metadataSearch: [] };
  const byTitle = new Map(workbook.tabs.map((t) => [t.title.toLowerCase(), t]));
  const newTableIds = [...(workbook.newTableIds ?? ["table-1", "table-2"])];

  const sheetPayload = (tab: FakeTab, range: string | undefined, includeGridData: boolean) => {
    const payload: Record<string, unknown> = {
      properties: {
        sheetId: tab.sheetId,
        title: tab.title,
        index: workbook.tabs.indexOf(tab),
        sheetType: "GRID",
        gridProperties: {
          rowCount: tab.rowCount ?? 1000,
          columnCount: tab.columnCount ?? 26,
          frozenRowCount: tab.frozenRowCount ?? 0,
        },
      },
      tables: tab.tables ?? [],
      protectedRanges: tab.protectedRanges ?? [],
      conditionalFormats: tab.conditionalFormats ?? [],
      basicFilter: tab.basicFilter,
    };
    if (!includeGridData) return payload;

    const window = bounds(range);
    const grid = tab.cells ?? [];
    const startRow = window?.startRow ?? 0;
    const startColumn = window?.startColumn ?? 0;
    const endRow = window?.endRow ?? grid.length - 1;
    const endColumn = window?.endColumn ?? Math.max(0, ...grid.map((r) => r.length - 1));

    const rowData: unknown[] = [];
    for (let r = startRow; r <= endRow; r += 1) {
      const row = grid[r] ?? [];
      const values: unknown[] = [];
      for (let c = startColumn; c <= endColumn; c += 1) values.push(cellData(toCell(row[c])));
      rowData.push({ values });
    }
    payload["data"] = [{ startRow, startColumn, rowData }];
    return payload;
  };

  const api = {
    spreadsheets: {
      async get(params: {
        spreadsheetId: string;
        fields?: string;
        ranges?: string[];
        includeGridData?: boolean;
      }) {
        calls.get.push(params);
        const wanted = params.ranges?.length
          ? params.ranges.map((reference) => {
              const { sheet, range } = splitSheetRange(reference);
              const tab = byTitle.get(String(sheet ?? "").toLowerCase());
              if (!tab) throw new Error(`fake: no tab ${sheet}`);
              return { tab, range: range || undefined };
            })
          : workbook.tabs.map((tab) => ({ tab, range: undefined as string | undefined }));

        return {
          data: {
            spreadsheetId: params.spreadsheetId,
            properties: { title: workbook.title ?? "Fake workbook" },
            namedRanges: workbook.namedRanges ?? [],
            sheets: wanted.map(({ tab, range }) =>
              sheetPayload(tab, range, params.includeGridData === true),
            ),
          },
        };
      },

      async batchUpdate(params: { spreadsheetId: string; requestBody: { requests: unknown[] } }) {
        calls.batchUpdate.push({ requests: params.requestBody.requests });
        const replies = params.requestBody.requests.map((request) => {
          const entry = request as { addTable?: { table?: { name?: string; range?: unknown } } };
          if (!entry.addTable) return {};
          return {
            addTable: {
              table: {
                tableId: newTableIds.shift() ?? "table-x",
                name: entry.addTable.table?.name,
                range: entry.addTable.table?.range,
              },
            },
          };
        });
        return { data: { replies } };
      },

      developerMetadata: {
        async search(params: unknown) {
          calls.metadataSearch.push(params);
          if (workbook.metadataThrows) throw new Error("metadata unavailable");
          return {
            data: {
              matchedDeveloperMetadata: (workbook.developerMetadata ?? []).map((m) => ({
                developerMetadata: m,
              })),
            },
          };
        },
      },

      values: {
        async batchGet() {
          return { data: { valueRanges: [] } };
        },
      },
    },
  };

  const infos: SheetInfo[] = workbook.tabs.map((t, index) => ({
    sheetId: t.sheetId,
    title: t.title,
    index,
    sheetType: "GRID",
    hidden: false,
    rowCount: t.rowCount ?? 1000,
    columnCount: t.columnCount ?? 26,
    frozenRowCount: t.frozenRowCount ?? 0,
    frozenColumnCount: 0,
  }));

  let registry: Registry | undefined;
  if (registryJson) registry = parseRegistry(registryJson, "test/.claude/gsheets-pro.json");

  const context = {
    auth: {
      client: {} as never,
      source: "oauth_token_file",
      location: "test",
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      hasRefreshToken: true,
    },
    sheets: api as never,
    drive: {} as never,
    cache: new SheetCache(async () => infos),
    registry,
  } as unknown as Context;

  return {
    context,
    calls,
    requests: () => calls.batchUpdate.flatMap((b) => b.requests),
  };
}

/** Every request of one kind out of what the tool sent. */
export function requestsOfKind<T = Record<string, unknown>>(requests: unknown[], kind: string): T[] {
  return requests
    .filter((r) => Object.prototype.hasOwnProperty.call(r as object, kind))
    .map((r) => (r as Record<string, T>)[kind]);
}

/** A `gsheets.column` metadata entry on a column, as the search returns it. */
export function columnMetadata(
  sheetId: number,
  columnIndex: number,
  value: Record<string, unknown>,
): { metadataKey: string; metadataValue: string; location: Record<string, unknown> } {
  return {
    metadataKey: "gsheets.column",
    metadataValue: JSON.stringify(value),
    location: {
      locationType: "COLUMN",
      dimensionRange: { sheetId, dimension: "COLUMNS", startIndex: columnIndex, endIndex: columnIndex + 1 },
    },
  };
}

/** A `gsheets.sheet` record, as the search returns it. */
export function sheetMetadata(
  sheetId: number,
  value: Record<string, unknown>,
): { metadataKey: string; metadataValue: string; location: Record<string, unknown> } {
  return {
    metadataKey: "gsheets.sheet",
    metadataValue: JSON.stringify(value),
    location: { locationType: "SHEET", sheetId },
  };
}
