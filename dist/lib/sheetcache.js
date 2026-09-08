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
const DEFAULT_TTL_MS = 5 * 60 * 1000;
export class SheetCache {
    loader;
    cache = new Map();
    inflight = new Map();
    ttlMs;
    now;
    constructor(loader, options = {}) {
        this.loader = loader;
        this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
        this.now = options.now ?? Date.now;
    }
    /** Drop what we know about a spreadsheet. Call after any structure change. */
    invalidate(spreadsheetId) {
        if (spreadsheetId)
            this.cache.delete(spreadsheetId);
        else
            this.cache.clear();
    }
    /** Feed the cache from a response a tool already had in hand. */
    prime(spreadsheetId, sheets) {
        const entry = index(sheets, this.now());
        this.cache.set(spreadsheetId, entry);
        return entry;
    }
    fresh(spreadsheetId) {
        const hit = this.cache.get(spreadsheetId);
        if (!hit)
            return undefined;
        if (this.now() - hit.loadedAt > this.ttlMs)
            return undefined;
        return hit;
    }
    /** Load the tab map, from cache when fresh. Concurrent callers share one load. */
    async list(spreadsheetId, force = false) {
        if (!force) {
            const hit = this.fresh(spreadsheetId);
            if (hit)
                return hit;
        }
        const pending = this.inflight.get(spreadsheetId);
        if (pending && !force)
            return pending;
        const load = (async () => {
            try {
                const sheets = await this.loader(spreadsheetId);
                return this.prime(spreadsheetId, sheets);
            }
            finally {
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
    async resolve(spreadsheetId, sheet) {
        const wanted = String(sheet ?? "").trim();
        if (!wanted) {
            throw err.invalid("sheet is required.", "Pass the tab name as a person would read it off the tab strip, for example Tracker.");
        }
        const key = wanted.toLowerCase();
        let entry = await this.list(spreadsheetId);
        let hit = entry.byName.get(key);
        if (!hit) {
            entry = await this.list(spreadsheetId, true);
            hit = entry.byName.get(key);
        }
        if (!hit)
            throw err.sheetNotFound(wanted, entry.titles);
        return hit;
    }
    /** Resolve by numeric id, which is what an API response hands back. */
    async resolveId(spreadsheetId, sheetId) {
        let entry = await this.list(spreadsheetId);
        let hit = entry.byId.get(sheetId);
        if (!hit) {
            entry = await this.list(spreadsheetId, true);
            hit = entry.byId.get(sheetId);
        }
        return hit;
    }
}
function index(sheets, loadedAt) {
    const byName = new Map();
    const byId = new Map();
    const titles = [];
    for (const sheet of sheets) {
        byName.set(sheet.title.toLowerCase(), sheet);
        byId.set(sheet.sheetId, sheet);
        titles.push(sheet.title);
    }
    return { byName, byId, titles, loadedAt };
}
/** The `fields` mask that feeds `sheetInfoFromProperties`, kept next to it. */
export const SHEET_PROPERTIES_MASK = "sheets.properties(sheetId,title,index,sheetType,hidden,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount))";
/** Map one `Schema$SheetProperties` onto our smaller shape. */
export function sheetInfoFromProperties(properties) {
    const sheetId = properties.sheetId;
    const title = properties.title;
    if (sheetId === undefined || sheetId === null || !title)
        return undefined;
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
//# sourceMappingURL=sheetcache.js.map