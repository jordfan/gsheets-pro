/**
 * A Sheets client whose cell values can be written to.
 *
 * There are three fakes and each answers a different question. `fakeContext.ts`
 * is read only, for `sheets_open` and `sheets_read`. `fakeMutations.ts` covers
 * the tools that restructure a spreadsheet without changing a cell's contents,
 * so it carries `batchUpdate`, `sheets.copyTo` and the Drive surface.
 *
 * This one is for the two tools that change values. It keeps a mutable grid: a
 * `values.batchUpdate` really does change it, `values.append` really does add
 * rows, and the error gate really does read back what the tool wrote, which is
 * the only way to test that an append landed where it was supposed to. It also
 * records every batchUpdate request, so a test can assert that, for instance,
 * `footerColorStyle` appears in none of them.
 *
 * All ids and names in it are invented.
 */

import type { Context } from "../../src/lib/client.js";
import { SheetCache, type SheetInfo } from "../../src/lib/sheetcache.js";
import { parseRegistry, type Registry } from "../../src/lib/registry.js";
import { parseA1, splitSheetRange, columnIndexToLetter } from "../../src/lib/a1.js";

export const WRITE_SPREADSHEET_ID = "1WrItEfAkEsPrEaDsHeEtIdAbCdEfGhIjKlMnOpQr";

export type Cell = string | number | boolean | null;

export interface WriteTabSpec {
  title: string;
  sheetId: number;
  frozenRowCount?: number;
  frozenColumnCount?: number;
  hideGridlines?: boolean;
  rowCount?: number;
  columnCount?: number;
  /** Displayed values. Also the formula source unless `formulas` is given. */
  values?: Cell[][];
  /** What a FORMULA render returns, if it differs. */
  formulas?: Cell[][];
  tables?: Array<{
    tableId: string;
    name?: string;
    range?: Record<string, number>;
    columnProperties?: Array<{ columnIndex?: number; columnName?: string; columnType?: string }>;
  }>;
  bandedRanges?: Array<{ bandedRangeId: number; range?: Record<string, number> }>;
  merges?: Array<Record<string, number>>;
  conditionalFormats?: number;
  /** A1 to ErrorValue type, so the gate has something to find. */
  errors?: Record<string, string>;
}

export interface WriteSpreadsheetSpec {
  title: string;
  tabs: WriteTabSpec[];
  theme?: {
    primaryFontFamily?: string;
    themeColors?: Array<{ colorType: string; color: { rgbColor: { red: number; green: number; blue: number } } }>;
  };
  developerMetadata?: Array<{
    metadataKey: string;
    metadataValue: string;
    location: Record<string, unknown>;
  }>;
}

export interface WriteCalls {
  get: Array<Record<string, unknown>>;
  batchGet: Array<Record<string, unknown>>;
  valuesBatchUpdate: Array<Record<string, unknown>>;
  valuesAppend: Array<Record<string, unknown>>;
  batchUpdate: Array<Record<string, unknown>>;
  metadataSearch: unknown[];
}

interface Tab extends WriteTabSpec {
  grid: Cell[][];
  formulaGrid: Cell[][];
}

function clone(rows: Cell[][] | undefined): Cell[][] {
  return (rows ?? []).map((row) => [...row]);
}

function ensure(grid: Cell[][], row: number, column: number): void {
  while (grid.length <= row) grid.push([]);
  const line = grid[row];
  while (line.length <= column) line.push("");
}

function sliceGrid(grid: Cell[][], range: string | undefined): Cell[][] {
  if (!range) return grid.map((row) => [...row]);
  const bounds = parseA1(range);
  const r1 = bounds.startRowIndex ?? 0;
  const r2 = bounds.endRowIndex ?? grid.length;
  const c1 = bounds.startColumnIndex ?? 0;
  const c2 = bounds.endColumnIndex ?? Math.max(...grid.map((r) => r.length), 0);
  const out: Cell[][] = [];
  for (let r = r1; r < Math.min(r2, grid.length); r += 1) {
    out.push((grid[r] ?? []).slice(c1, c2));
  }
  // Trailing empty rows are not returned by the real API either.
  while (out.length && out[out.length - 1].every((c) => c === "" || c === null || c === undefined)) {
    out.pop();
  }
  return out;
}

export function makeWriteContext(
  spec: WriteSpreadsheetSpec,
  registryJson?: string,
): { context: Context; calls: WriteCalls; tabs: Map<string, Tab> } {
  const calls: WriteCalls = {
    get: [],
    batchGet: [],
    valuesBatchUpdate: [],
    valuesAppend: [],
    batchUpdate: [],
    metadataSearch: [],
  };

  const tabs = new Map<string, Tab>();
  for (const tab of spec.tabs) {
    tabs.set(tab.title.toLowerCase(), {
      ...tab,
      grid: clone(tab.values),
      formulaGrid: clone(tab.formulas ?? tab.values),
    });
  }

  const tabFor = (reference: string): Tab => {
    const { sheet } = splitSheetRange(reference);
    const hit = tabs.get(String(sheet ?? "").toLowerCase());
    if (!hit) throw new Error(`fake: no tab named ${sheet}`);
    return hit;
  };

  const writeRange = (reference: string, values: Cell[][]): { cells: number; rows: number } => {
    const tab = tabFor(reference);
    const body = splitSheetRange(reference).range;
    const bounds = parseA1(body);
    const startRow = bounds.startRowIndex ?? 0;
    const startColumn = bounds.startColumnIndex ?? 0;
    let cells = 0;
    values.forEach((row, r) => {
      row.forEach((value, c) => {
        ensure(tab.grid, startRow + r, startColumn + c);
        ensure(tab.formulaGrid, startRow + r, startColumn + c);
        tab.grid[startRow + r][startColumn + c] = value;
        tab.formulaGrid[startRow + r][startColumn + c] = value;
        cells += 1;
      });
    });
    return { cells, rows: values.length };
  };

  const gridDataFor = (tab: Tab, range: string | undefined) => {
    const body = range ? splitSheetRange(range).range : undefined;
    const bounds = body ? parseA1(body) : {};
    const startRow = bounds.startRowIndex ?? 0;
    const startColumn = bounds.startColumnIndex ?? 0;
    const rows = sliceGrid(tab.formulaGrid, body || undefined);
    return {
      startRow,
      startColumn,
      rowData: rows.map((row, r) => ({
        values: row.map((value, c) => {
          const a1 = `${columnIndexToLetter(startColumn + c)}${startRow + r + 1}`;
          const cell: Record<string, unknown> = {};
          if (typeof value === "string" && value.startsWith("=")) {
            cell["userEnteredValue"] = { formulaValue: value };
          }
          const error = tab.errors?.[a1];
          if (error) cell["effectiveValue"] = { errorValue: { type: error } };
          return cell;
        }),
      })),
    };
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
          ? params.ranges.map((reference) => ({ tab: tabFor(reference), reference }))
          : [...tabs.values()].map((tab) => ({ tab, reference: undefined as string | undefined }));

        return {
          data: {
            spreadsheetId: params.spreadsheetId,
            properties: {
              title: spec.title,
              ...(spec.theme ? { spreadsheetTheme: spec.theme } : {}),
            },
            sheets: wanted.map(({ tab, reference }) => ({
              properties: {
                sheetId: tab.sheetId,
                title: tab.title,
                index: 0,
                sheetType: "GRID",
                hidden: false,
                gridProperties: {
                  rowCount: tab.rowCount ?? 1000,
                  columnCount: tab.columnCount ?? 26,
                  frozenRowCount: tab.frozenRowCount ?? 0,
                  frozenColumnCount: tab.frozenColumnCount ?? 0,
                  hideGridlines: tab.hideGridlines === true,
                },
              },
              tables: tab.tables ?? [],
              bandedRanges: tab.bandedRanges ?? [],
              merges: tab.merges ?? [],
              conditionalFormats: new Array(tab.conditionalFormats ?? 0).fill({ ranges: [] }),
              protectedRanges: [],
              data: params.includeGridData ? [gridDataFor(tab, reference)] : undefined,
            })),
          },
        };
      },

      async batchUpdate(params: { spreadsheetId: string; requestBody: { requests: unknown[] } }) {
        calls.batchUpdate.push(params);
        return { data: { replies: params.requestBody.requests.map(() => ({})) } };
      },

      developerMetadata: {
        async search(params: unknown) {
          calls.metadataSearch.push(params);
          return {
            data: {
              matchedDeveloperMetadata: (spec.developerMetadata ?? []).map((m) => ({
                developerMetadata: m,
              })),
            },
          };
        },
      },

      values: {
        async batchGet(params: { ranges: string[]; valueRenderOption?: string; majorDimension?: string }) {
          calls.batchGet.push(params);
          return {
            data: {
              valueRanges: params.ranges.map((reference) => {
                const tab = tabFor(reference);
                const body = splitSheetRange(reference).range;
                const source =
                  params.valueRenderOption === "FORMULA" ? tab.formulaGrid : tab.grid;
                let values = sliceGrid(source, body || undefined);
                if (params.majorDimension === "COLUMNS") {
                  const width = Math.max(...values.map((r) => r.length), 0);
                  const flipped: Cell[][] = [];
                  for (let c = 0; c < width; c += 1) {
                    flipped.push(values.map((row) => row[c] ?? ""));
                  }
                  values = flipped;
                }
                return { range: reference, values };
              }),
            },
          };
        },

        async batchUpdate(params: {
          spreadsheetId: string;
          requestBody: { valueInputOption: string; data: Array<{ range: string; values: Cell[][] }> };
        }) {
          calls.valuesBatchUpdate.push(params);
          let cells = 0;
          let rows = 0;
          for (const entry of params.requestBody.data) {
            const written = writeRange(entry.range, entry.values);
            cells += written.cells;
            rows += written.rows;
          }
          return { data: { totalUpdatedCells: cells, totalUpdatedRows: rows } };
        },

        async append(params: {
          spreadsheetId: string;
          range: string;
          valueInputOption: string;
          insertDataOption?: string;
          requestBody: { values: Cell[][] };
        }) {
          calls.valuesAppend.push(params);
          const tab = tabFor(params.range);
          const body = splitSheetRange(params.range).range;
          const bounds = parseA1(body);
          const startColumn = bounds.startColumnIndex ?? 0;
          // The real API lands the rows after the last filled row of the range.
          let landing = bounds.startRowIndex ?? 0;
          for (let r = landing; r < (bounds.endRowIndex ?? tab.grid.length); r += 1) {
            if ((tab.grid[r] ?? []).some((c) => String(c ?? "").trim() !== "")) landing = r + 1;
          }
          const values = params.requestBody.values;
          values.forEach((row, r) => {
            row.forEach((value, c) => {
              ensure(tab.grid, landing + r, startColumn + c);
              ensure(tab.formulaGrid, landing + r, startColumn + c);
              tab.grid[landing + r][startColumn + c] = value;
              tab.formulaGrid[landing + r][startColumn + c] = value;
            });
          });
          const width = Math.max(...values.map((r) => r.length), 0);
          const updatedRange = `'${tab.title}'!${columnIndexToLetter(startColumn)}${landing + 1}:${columnIndexToLetter(startColumn + width - 1)}${landing + values.length}`;
          return {
            data: {
              updates: {
                updatedRange,
                updatedRows: values.length,
                updatedCells: values.length * width,
              },
            },
          };
        },

        async update(params: { range: string; requestBody: { values: Cell[][] } }) {
          const written = writeRange(params.range, params.requestBody.values);
          return { data: { updatedCells: written.cells, updatedRows: written.rows } };
        },
      },
    },
  };

  const infos: SheetInfo[] = spec.tabs.map((t, index) => ({
    sheetId: t.sheetId,
    title: t.title,
    index,
    sheetType: "GRID",
    hidden: false,
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

  return { context, calls, tabs };
}

/** Every request of one kind sent across every batchUpdate call. */
export function requestsOfKind(calls: WriteCalls, kind: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const call of calls.batchUpdate) {
    const body = call["requestBody"] as { requests?: Array<Record<string, unknown>> } | undefined;
    for (const request of body?.requests ?? []) {
      if (kind in request) out.push(request[kind] as Record<string, unknown>);
    }
  }
  return out;
}

/** Everything sent to batchUpdate, as one JSON string, for absence assertions. */
export function batchUpdateJson(calls: WriteCalls): string {
  return JSON.stringify(calls.batchUpdate);
}
