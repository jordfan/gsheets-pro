/**
 * A fake Sheets and Drive client for the tools that write.
 *
 * Deliberately separate from `fakeContext.ts`, which serves the read tools: the
 * mutating tools need `batchUpdate`, `sheets.copyTo`, the Drive surface and a
 * `spreadsheets.get` that answers the error gate's mask, and layering all of
 * that onto the read fake would make both harder to follow.
 *
 * Every id and name here is invented.
 */

import { SheetCache, type SheetInfo } from "../../src/lib/sheetcache.js";
import { parseRegistry, type Registry } from "../../src/lib/registry.js";
import { splitSheetRange } from "../../src/lib/a1.js";
import type { Context } from "../../src/lib/client.js";

export const MUT_SPREADSHEET_ID = "1FaKeMuTaTiOnSpReAdShEeTiDaBcDeFgHiJkLm";

export interface MutTab {
  title: string;
  sheetId: number;
  index?: number;
  rowCount?: number;
  columnCount?: number;
  frozenRowCount?: number;
  /** The header row, returned by the values read that sort and dedupe make. */
  headers?: string[];
  protectedRanges?: Array<{
    protectedRangeId: number;
    range?: Record<string, number>;
    description?: string;
    warningOnly?: boolean;
  }>;
  /** Cells the error gate should report, keyed A1 to an ErrorValue type. */
  errorCells?: Record<string, string>;
  /** Cells the error gate should count as formulas, by A1. */
  formulaCells?: string[];
}

export interface MutSpreadsheet {
  title?: string;
  tabs: MutTab[];
}

export interface MutCalls {
  batchUpdate: Array<{ spreadsheetId: string; requests: unknown[] }>;
  get: Array<{ ranges?: string[]; includeGridData?: boolean; fields?: string }>;
  valuesBatchGet: Array<{ ranges: string[] }>;
  copyTo: Array<{ spreadsheetId: string; sheetId: number; destinationSpreadsheetId: string }>;
  driveList: unknown[];
  driveCopy: unknown[];
  drivePermissions: unknown[];
}

export interface FakeMutationOptions {
  registryJson?: string;
  scopes?: string[];
  /** Files `drive.files.list` should return. */
  driveFiles?: Array<{ id: string; name: string; modifiedTime?: string; webViewLink?: string }>;
  /** Make a Drive call fail the way Google does when a scope is missing. */
  driveError?: { status: number; message: string };
  /** Replies the fake batchUpdate hands back, in request order. */
  replies?: unknown[];
  /** Errors the gate finds on its second read, so LOADING can be made to clear. */
  errorCellsAfterRetry?: Record<string, Record<string, string>>;
}

function columnToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function makeMutationContext(
  spreadsheet: MutSpreadsheet,
  options: FakeMutationOptions = {},
): { context: Context; calls: MutCalls } {
  const calls: MutCalls = {
    batchUpdate: [],
    get: [],
    valuesBatchGet: [],
    copyTo: [],
    driveList: [],
    driveCopy: [],
    drivePermissions: [],
  };
  const byTitle = new Map(spreadsheet.tabs.map((t) => [t.title.toLowerCase(), t]));
  let getCount = 0;

  const gridFor = (tab: MutTab, retry: boolean) => {
    const errors = retry
      ? (options.errorCellsAfterRetry?.[tab.title] ?? tab.errorCells ?? {})
      : (tab.errorCells ?? {});
    const formulas = new Set(tab.formulaCells ?? []);
    const cells = new Map<string, { row: number; column: number; error?: string; formula?: boolean }>();
    for (const [a1, type] of Object.entries(errors)) {
      const m = /^([A-Z]+)(\d+)$/.exec(a1.toUpperCase());
      if (!m) continue;
      cells.set(a1, { row: Number(m[2]) - 1, column: columnToIndex(m[1]), error: type });
    }
    for (const a1 of formulas) {
      const m = /^([A-Z]+)(\d+)$/.exec(a1.toUpperCase());
      if (!m) continue;
      const existing = cells.get(a1);
      if (existing) existing.formula = true;
      else cells.set(a1, { row: Number(m[2]) - 1, column: columnToIndex(m[1]), formula: true });
    }

    const maxRow = Math.max(-1, ...[...cells.values()].map((c) => c.row));
    const maxCol = Math.max(-1, ...[...cells.values()].map((c) => c.column));
    const rowData = [];
    for (let r = 0; r <= maxRow; r += 1) {
      const values = [];
      for (let c = 0; c <= maxCol; c += 1) {
        const hit = [...cells.values()].find((cell) => cell.row === r && cell.column === c);
        const cell: Record<string, unknown> = {};
        if (hit?.formula) cell["userEnteredValue"] = { formulaValue: "=SUM(A1:A2)" };
        if (hit?.error) cell["effectiveValue"] = { errorValue: { type: hit.error, message: "fake" } };
        values.push(cell);
      }
      rowData.push({ values });
    }
    return { startRow: 0, startColumn: 0, rowData };
  };

  const sheets = {
    spreadsheets: {
      async get(params: {
        spreadsheetId: string;
        ranges?: string[];
        includeGridData?: boolean;
        fields?: string;
      }) {
        calls.get.push({
          ...(params.ranges ? { ranges: params.ranges } : {}),
          ...(params.includeGridData !== undefined ? { includeGridData: params.includeGridData } : {}),
          ...(params.fields ? { fields: params.fields } : {}),
        });
        getCount += 1;
        const retry = getCount > 1;
        const wanted = params.ranges?.length
          ? params.ranges.map((r) => {
              const { sheet } = splitSheetRange(r);
              const tab = byTitle.get(String(sheet ?? "").toLowerCase());
              if (!tab) throw new Error(`fake: no tab ${sheet}`);
              return tab;
            })
          : spreadsheet.tabs;
        return {
          data: {
            sheets: wanted.map((tab) => ({
              properties: { sheetId: tab.sheetId, title: tab.title },
              protectedRanges: tab.protectedRanges ?? [],
              ...(params.includeGridData ? { data: [gridFor(tab, retry)] } : {}),
            })),
          },
        };
      },

      async batchUpdate(params: { spreadsheetId: string; requestBody: { requests: unknown[] } }) {
        calls.batchUpdate.push({
          spreadsheetId: params.spreadsheetId,
          requests: params.requestBody.requests,
        });
        return {
          data: {
            replies: options.replies ?? params.requestBody.requests.map(() => ({})),
          },
        };
      },

      sheets: {
        async copyTo(params: {
          spreadsheetId: string;
          sheetId: number;
          requestBody: { destinationSpreadsheetId: string };
        }) {
          calls.copyTo.push({
            spreadsheetId: params.spreadsheetId,
            sheetId: params.sheetId,
            destinationSpreadsheetId: params.requestBody.destinationSpreadsheetId,
          });
          return { data: { sheetId: 9001, title: "Copy of Roster" } };
        },
      },

      values: {
        async batchGet(params: { ranges: string[] }) {
          calls.valuesBatchGet.push({ ranges: params.ranges });
          return {
            data: {
              valueRanges: params.ranges.map((reference) => {
                const { sheet } = splitSheetRange(reference);
                const tab = byTitle.get(String(sheet ?? "").toLowerCase());
                return { range: reference, values: tab?.headers ? [tab.headers] : [] };
              }),
            },
          };
        },
      },
    },
  };

  const driveFail = () => {
    if (!options.driveError) return;
    const error = new Error(options.driveError.message) as Error & {
      response?: { status: number };
      code?: number;
    };
    error.response = { status: options.driveError.status };
    error.code = options.driveError.status;
    throw error;
  };

  const drive = {
    files: {
      async list(params: unknown) {
        calls.driveList.push(params);
        driveFail();
        return {
          data: {
            files: (options.driveFiles ?? []).map((f) => ({
              id: f.id,
              name: f.name,
              modifiedTime: f.modifiedTime ?? "2026-09-01T12:00:00Z",
              webViewLink: f.webViewLink ?? `https://docs.google.com/spreadsheets/d/${f.id}/edit`,
              owners: [{ displayName: "Test Owner", emailAddress: "owner@example.org" }],
            })),
          },
        };
      },
      async copy(params: { fileId: string; requestBody: { name?: string } }) {
        calls.driveCopy.push(params);
        driveFail();
        return {
          data: {
            id: "1CoPiEdSpReAdShEeTiDaBcDeFgHiJkLmNoPq",
            name: params.requestBody.name ?? "Copy",
            webViewLink: "https://docs.google.com/spreadsheets/d/1CoPiEdSpReAdShEeTiDaBcDeFgHiJkLmNoPq/edit",
          },
        };
      },
    },
    permissions: {
      async create(params: unknown) {
        calls.drivePermissions.push(params);
        driveFail();
        return { data: { id: "perm-1", type: "user", role: "reader" } };
      },
    },
  };

  const infos: SheetInfo[] = spreadsheet.tabs.map((t) => ({
    sheetId: t.sheetId,
    title: t.title,
    index: t.index ?? 0,
    sheetType: "GRID",
    hidden: false,
    rowCount: t.rowCount ?? 1000,
    columnCount: t.columnCount ?? 26,
    frozenRowCount: t.frozenRowCount ?? 0,
    frozenColumnCount: 0,
  }));

  let registry: Registry | undefined;
  if (options.registryJson) {
    registry = parseRegistry(options.registryJson, "test/.claude/gsheets-pro.json");
  }

  const context = {
    auth: {
      client: {} as never,
      source: "oauth_token_file",
      location: "test",
      scopes: options.scopes ?? [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive.file",
      ],
      hasRefreshToken: true,
    },
    sheets: sheets as never,
    drive: drive as never,
    cache: new SheetCache(async () => infos),
    registry,
  } as unknown as Context;

  return { context, calls };
}

/** The one request a batch produced, for a test that expects exactly one. */
export function onlyRequest(calls: MutCalls): Record<string, unknown> {
  if (calls.batchUpdate.length !== 1) {
    throw new Error(`expected one batchUpdate, saw ${calls.batchUpdate.length}`);
  }
  const requests = calls.batchUpdate[0].requests;
  if (requests.length !== 1) throw new Error(`expected one request, saw ${requests.length}`);
  return requests[0] as Record<string, unknown>;
}
