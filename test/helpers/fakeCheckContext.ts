/**
 * A fake context for `sheets_check`, built out of the same fixtures the rules
 * are tested with.
 *
 * The tool makes two reads in a fixed order and the order is part of what is
 * being tested, so this fake records both calls: the FORMULA values read that
 * discovers each tab's extent, and the masked grid read that follows it. A test
 * can then assert that the grid read was bounded to the used range rather than
 * to the whole million-cell tab, which is the difference between a lint that is
 * cheap to run and one nobody runs.
 */

import type { Context } from "../../src/lib/client.js";
import { SheetCache, type SheetInfo } from "../../src/lib/sheetcache.js";
import { parseRegistry } from "../../src/lib/registry.js";
import { splitSheetRange } from "../../src/lib/a1.js";
import type { LintSheet } from "../../src/lib/lint/types.js";
import {
  formulaGrid,
  sheetFixture,
  FIXTURE_SPREADSHEET_ID,
  type CellInput,
  type SheetFixtureOptions,
} from "./lintFixtures.js";

export { FIXTURE_SPREADSHEET_ID };

export interface FakeTabSpec extends Omit<SheetFixtureOptions, "title"> {
  title: string;
  hidden?: boolean;
  rows: CellInput[][];
}

export interface FakeCheckCalls {
  batchGet: Array<{ ranges: string[]; valueRenderOption?: string }>;
  get: Array<{ ranges?: string[]; fields?: string }>;
  metadataSearch: number;
}

export interface FakeCheckOptions {
  registryJson?: string;
  developerMetadata?: Array<{ metadataKey: string; metadataValue: string; location: Record<string, unknown> }>;
  metadataThrows?: boolean;
  /** Return LOADING on the first read and settled values afterwards. */
  settleAfter?: number;
}

/** The same cell as Sheets reports it while a volatile formula settles. */
function stillCalculating(cell: CellInput): CellInput {
  if (typeof cell === "string" && cell.startsWith("=")) return { formula: cell, error: "LOADING" };
  if (cell && typeof cell === "object" && cell.formula) return { ...cell, error: "LOADING" };
  return cell;
}

export function makeCheckContext(
  tabs: FakeTabSpec[],
  options: FakeCheckOptions = {},
): { context: Context; calls: FakeCheckCalls } {
  const calls: FakeCheckCalls = { batchGet: [], get: [], metadataSearch: 0 };
  let reads = 0;

  const infos: SheetInfo[] = tabs.map((tab, index) => ({
    sheetId: tab.sheetId ?? index + 1,
    title: tab.title,
    index,
    sheetType: "GRID",
    hidden: tab.hidden === true,
    rowCount: 1000,
    columnCount: 26,
    frozenRowCount: tab.frozenRows ?? 0,
    frozenColumnCount: 0,
  }));

  const byTitle = new Map(tabs.map((tab) => [tab.title.toLowerCase(), tab]));

  const buildSheet = (tab: FakeTabSpec): LintSheet => {
    const settled = options.settleAfter === undefined || reads > options.settleAfter;
    const rows = settled ? tab.rows : tab.rows.map((row) => row.map(stillCalculating));
    return sheetFixture({ ...tab, rows });
  };

  const api = {
    spreadsheets: {
      async get(params: { spreadsheetId: string; ranges?: string[]; fields?: string }) {
        reads += 1;
        calls.get.push({ ...(params.ranges ? { ranges: params.ranges } : {}), ...(params.fields ? { fields: params.fields } : {}) });
        const wanted = params.ranges?.length
          ? params.ranges.map((reference) => splitSheetRange(reference).sheet ?? "")
          : tabs.map((tab) => tab.title);
        return {
          data: {
            spreadsheetId: params.spreadsheetId,
            sheets: wanted.flatMap((title) => {
              const tab = byTitle.get(String(title).toLowerCase());
              return tab ? [buildSheet(tab)] : [];
            }),
          },
        };
      },

      developerMetadata: {
        async search(_params: unknown) {
          calls.metadataSearch += 1;
          if (options.metadataThrows) throw new Error("metadata unavailable");
          return {
            data: {
              matchedDeveloperMetadata: (options.developerMetadata ?? []).map((m) => ({
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
                const { sheet } = splitSheetRange(reference);
                const tab = byTitle.get(String(sheet ?? "").toLowerCase());
                if (!tab) throw new Error(`fake: no tab ${sheet}`);
                return { range: reference, values: formulaGrid(tab.rows) };
              }),
            },
          };
        },
      },
    },
  };

  const context = {
    auth: { client: {}, source: "oauth_token_file", location: "test", scopes: [], hasRefreshToken: true },
    sheets: api as never,
    drive: {} as never,
    cache: new SheetCache(async () => infos),
    registry: options.registryJson
      ? parseRegistry(options.registryJson, "test/.claude/gsheets-pro.json")
      : undefined,
  } as unknown as Context;

  return { context, calls };
}
