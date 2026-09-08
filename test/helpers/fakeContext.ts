/**
 * A fake Google Sheets client and Context, so the tool handlers can be exercised
 * offline. Everything here uses invented spreadsheet ids and invented names.
 */

import type { Context } from "../../src/lib/client.js";
import { SheetCache, type SheetInfo } from "../../src/lib/sheetcache.js";
import { parseRegistry, type Registry } from "../../src/lib/registry.js";
import { splitSheetRange } from "../../src/lib/a1.js";

export const FAKE_SPREADSHEET_ID = "1TeStFaKeSpReAdShEeTiDaBcDeFgHiJkLmNoPqRs";

export interface FakeTab {
  title: string;
  sheetId: number;
  index?: number;
  hidden?: boolean;
  rowCount?: number;
  columnCount?: number;
  frozenRowCount?: number;
  frozenColumnCount?: number;
  /** Displayed values, row major, starting at A1. */
  values?: Array<Array<string | number | boolean | null>>;
  /** Formula strings, same shape, for the formula render option. */
  formulas?: Array<Array<string | number | boolean | null>>;
  tables?: Array<{
    tableId: string;
    name?: string;
    range?: unknown;
    columnProperties?: Array<{ columnIndex?: number; columnName?: string; columnType?: string }>;
  }>;
  protectedRanges?: Array<{ range?: unknown; description?: string; warningOnly?: boolean; requestingUserCanEdit?: boolean }>;
  bandedRanges?: unknown[];
  basicFilter?: unknown;
  merges?: unknown[];
  /** Validation keyed by zero based column index, applied to the first data row. */
  validation?: Record<number, { type: string; values: string[]; strict?: boolean }>;
  notes?: Record<string, string>;
}

export interface FakeSpreadsheet {
  title: string;
  locale?: string;
  timeZone?: string;
  tabs: FakeTab[];
  namedRanges?: Array<{ name: string; range: unknown }>;
  developerMetadata?: Array<{
    metadataKey: string;
    metadataValue: string;
    location: Record<string, unknown>;
  }>;
  /** Make developerMetadata.search fail, which is common on a human's sheet. */
  metadataThrows?: boolean;
}

export interface FakeCalls {
  get: unknown[];
  batchGet: unknown[];
  create: unknown[];
  metadataSearch: unknown[];
}

function slice(
  values: Array<Array<string | number | boolean | null>>,
  range: string | undefined,
): Array<Array<string | number | boolean | null>> {
  if (!range) return values;
  const m = /^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/.exec(range.toUpperCase());
  if (!m) return values;
  const toIndex = (letters: string) => {
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  const c1 = toIndex(m[1]);
  const r1 = m[2] ? Number(m[2]) - 1 : 0;
  const c2 = m[3] ? toIndex(m[3]) : c1;
  const r2 = m[4] ? Number(m[4]) - 1 : values.length - 1;
  return values
    .slice(r1, r2 + 1)
    .map((row) => row.slice(c1, c2 + 1))
    .filter((row, i, arr) => i < arr.length);
}

export function makeFakeContext(spreadsheet: FakeSpreadsheet, registryJson?: string): {
  context: Context;
  calls: FakeCalls;
} {
  const calls: FakeCalls = { get: [], batchGet: [], create: [], metadataSearch: [] };
  const byTitle = new Map(spreadsheet.tabs.map((t) => [t.title.toLowerCase(), t]));

  const api = {
    spreadsheets: {
      async get(params: { spreadsheetId: string; fields?: string; ranges?: string[]; includeGridData?: boolean }) {
        calls.get.push(params);
        const wanted = params.ranges?.length
          ? params.ranges.map((r) => {
              const { sheet } = splitSheetRange(r);
              const tab = byTitle.get(String(sheet ?? "").toLowerCase());
              if (!tab) throw new Error(`fake: no tab ${sheet}`);
              return { tab, range: splitSheetRange(r).range };
            })
          : spreadsheet.tabs.map((tab) => ({ tab, range: undefined as string | undefined }));

        return {
          data: {
            spreadsheetId: params.spreadsheetId,
            properties: {
              title: spreadsheet.title,
              locale: spreadsheet.locale ?? "en_US",
              timeZone: spreadsheet.timeZone ?? "America/New_York",
            },
            namedRanges: spreadsheet.namedRanges ?? [],
            sheets: wanted.map(({ tab, range }) => ({
              properties: {
                sheetId: tab.sheetId,
                title: tab.title,
                index: tab.index ?? 0,
                sheetType: "GRID",
                hidden: tab.hidden === true,
                gridProperties: {
                  rowCount: tab.rowCount ?? 1000,
                  columnCount: tab.columnCount ?? 26,
                  frozenRowCount: tab.frozenRowCount ?? 0,
                  frozenColumnCount: tab.frozenColumnCount ?? 0,
                },
              },
              tables: tab.tables ?? [],
              protectedRanges: tab.protectedRanges ?? [],
              bandedRanges: tab.bandedRanges ?? [],
              basicFilter: tab.basicFilter,
              merges: tab.merges ?? [],
              data: params.includeGridData
                ? [gridDataFor(tab, range)]
                : undefined,
            })),
          },
        };
      },

      async create(params: { requestBody: { properties?: { title?: string } } }) {
        calls.create.push(params);
        return { data: { spreadsheetId: FAKE_SPREADSHEET_ID } };
      },

      developerMetadata: {
        async search(params: unknown) {
          calls.metadataSearch.push(params);
          if (spreadsheet.metadataThrows) throw new Error("metadata unavailable");
          return {
            data: {
              matchedDeveloperMetadata: (spreadsheet.developerMetadata ?? []).map((m) => ({
                developerMetadata: m,
              })),
            },
          };
        },
      },

      values: {
        async batchGet(params: { ranges: string[]; valueRenderOption?: string }) {
          calls.batchGet.push(params);
          return {
            data: {
              valueRanges: params.ranges.map((reference) => {
                const { sheet, range } = splitSheetRange(reference);
                const tab = byTitle.get(String(sheet ?? "").toLowerCase());
                if (!tab) throw new Error(`fake: no tab ${sheet}`);
                const source =
                  params.valueRenderOption === "FORMULA" && tab.formulas
                    ? tab.formulas
                    : (tab.values ?? []);
                return { range: reference, values: slice(source, range || undefined) };
              }),
            },
          };
        },
      },
    },
  };

  const infos: SheetInfo[] = spreadsheet.tabs.map((t) => ({
    sheetId: t.sheetId,
    title: t.title,
    index: t.index ?? 0,
    sheetType: "GRID",
    hidden: t.hidden === true,
    rowCount: t.rowCount ?? 1000,
    columnCount: t.columnCount ?? 26,
    frozenRowCount: t.frozenRowCount ?? 0,
    frozenColumnCount: t.frozenColumnCount ?? 0,
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

  return { context, calls };
}

function gridDataFor(tab: FakeTab, range: string | undefined) {
  const m = range ? /^([A-Z]+)(\d+)/.exec(range.toUpperCase()) : null;
  const startRow = m ? Number(m[2]) - 1 : 0;
  const rows = slice(tab.values ?? [], range || undefined);
  return {
    startRow,
    startColumn: 0,
    rowData: rows.map((row, r) => ({
      values: row.map((_, c) => {
        const cell: Record<string, unknown> = {};
        const validation = tab.validation?.[c];
        if (validation && startRow + r >= (tab.frozenRowCount ?? 1)) {
          cell["dataValidation"] = {
            condition: {
              type: validation.type,
              values: validation.values.map((v) => ({ userEnteredValue: v })),
            },
            strict: validation.strict !== false,
          };
        }
        return cell;
      }),
    })),
  };
}
