/**
 * Tab name to sheet id, cached at module scope.
 *
 * Every tool takes a tab NAME, because that is what a person reading the sheet
 * sees, and the API takes a numeric sheet id. Resolving that costs a
 * `spreadsheets.get` and there are only 60 reads a minute, so the map is cached
 * across calls and, in HTTP mode, across requests: the McpServer is rebuilt per
 * request but this module is not.
 *
 * A miss always refreshes before it fails, so a tab created a second ago
 * resolves rather than producing a confusing "no tab named" error.
 */

import { err } from "./errors.js";

export interface SheetInfo {
  sheetId: number;
  title: string;
  index: number;
  sheetType: string;
  hidden: boolean;
  rowCount?: number;
  columnCount?: number;
  frozenRowCount?: number;
  frozenColumnCount?: number;
}

export interface SpreadsheetSheets {
  /** Keyed by lowercased title. */
  byName: Map<string, SheetInfo>;
  /** Keyed by numeric sheet id. */
  byId: Map<number, SheetInfo>;
  /** Tab titles in tab order, as a person would read them. */
  titles: string[];
  loadedAt: number;
}

/** The shape of what a loader hands back: one entry per tab. */
export type SheetLoader = (spreadsheetId: string) => Promise<SheetInfo[]>;

export interface SheetCacheOptions {
  /** How long a map stays fresh. Default 5 minutes. */
  ttlMs?: number;
  /** Injectable for tests. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class SheetCache {
  private readonly cache = new Map<string, SpreadsheetSheets>();
  private readonly inflight = new Map<string, Promise<SpreadsheetSheets>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly loader: SheetLoader,
    options: SheetCacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** Drop what we know about a spreadsheet. Call after any structure change. */
  invalidate(spreadsheetId?: string): void {
    if (spreadsheetId) this.cache.delete(spreadsheetId);
    else this.cache.clear();
  }

  /** Feed the cache from a response a tool already had in hand. */
  prime(spreadsheetId: string, sheets: SheetInfo[]): SpreadsheetSheets {
    const entry = index(sheets, this.now());
    this.cache.set(spreadsheetId, entry);
    return entry;
  }

  private fresh(spreadsheetId: string): SpreadsheetSheets | undefined {
    const hit = this.cache.get(spreadsheetId);
    if (!hit) return undefined;
    if (this.now() - hit.loadedAt > this.ttlMs) return undefined;
    return hit;
  }

  /** Load the tab map, from cache when fresh. Concurrent callers share one load. */
  async list(spreadsheetId: string, force = false): Promise<SpreadsheetSheets> {
    if (!force) {
      const hit = this.fresh(spreadsheetId);
      if (hit) return hit;
    }
    const pending = this.inflight.get(spreadsheetId);
    if (pending && !force) return pending;

    const load = (async () => {
      try {
        const sheets = await this.loader(spreadsheetId);
        return this.prime(spreadsheetId, sheets);
      } finally {
        this.inflight.delete(spreadsheetId);
      }
    })();
    this.inflight.set(spreadsheetId, load);
    return load;
  }

  /**
   * Resolve a tab name to its info, refreshing once on a miss so a tab created
   * moments ago is found rather than reported missing.
   */
  async resolve(spreadsheetId: string, sheet: string): Promise<SheetInfo> {
    const wanted = String(sheet ?? "").trim();
    if (!wanted) {
      throw err.invalid(
        "sheet is required.",
        "Pass the tab name as a person would read it off the tab strip, for example Tracker.",
      );
    }
    const key = wanted.toLowerCase();

    let entry = await this.list(spreadsheetId);
    let hit = entry.byName.get(key);
    if (!hit) {
      entry = await this.list(spreadsheetId, true);
      hit = entry.byName.get(key);
    }
    if (!hit) throw err.sheetNotFound(wanted, entry.titles);
    return hit;
  }

  /** Resolve by numeric id, which is what an API response hands back. */
  async resolveId(spreadsheetId: string, sheetId: number): Promise<SheetInfo | undefined> {
    let entry = await this.list(spreadsheetId);
    let hit = entry.byId.get(sheetId);
    if (!hit) {
      entry = await this.list(spreadsheetId, true);
      hit = entry.byId.get(sheetId);
    }
    return hit;
  }
}

function index(sheets: SheetInfo[], loadedAt: number): SpreadsheetSheets {
  const byName = new Map<string, SheetInfo>();
  const byId = new Map<number, SheetInfo>();
  const titles: string[] = [];
  for (const sheet of sheets) {
    byName.set(sheet.title.toLowerCase(), sheet);
    byId.set(sheet.sheetId, sheet);
    titles.push(sheet.title);
  }
  return { byName, byId, titles, loadedAt };
}

/** The `fields` mask that feeds `sheetInfoFromProperties`, kept next to it. */
export const SHEET_PROPERTIES_MASK =
  "sheets.properties(sheetId,title,index,sheetType,hidden,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount))";

/** Map one `Schema$SheetProperties` onto our smaller shape. */
export function sheetInfoFromProperties(properties: {
  sheetId?: number | null;
  title?: string | null;
  index?: number | null;
  sheetType?: string | null;
  hidden?: boolean | null;
  gridProperties?: {
    rowCount?: number | null;
    columnCount?: number | null;
    frozenRowCount?: number | null;
    frozenColumnCount?: number | null;
  } | null;
}): SheetInfo | undefined {
  const sheetId = properties.sheetId;
  const title = properties.title;
  if (sheetId === undefined || sheetId === null || !title) return undefined;
  const grid = properties.gridProperties ?? {};
  return {
    sheetId,
    title,
    index: properties.index ?? 0,
    sheetType: properties.sheetType ?? "GRID",
    hidden: properties.hidden === true,
    rowCount: grid.rowCount ?? undefined,
    columnCount: grid.columnCount ?? undefined,
    frozenRowCount: grid.frozenRowCount ?? undefined,
    frozenColumnCount: grid.frozenColumnCount ?? undefined,
  };
}
