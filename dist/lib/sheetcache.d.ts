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
export declare class SheetCache {
    private readonly loader;
    private readonly cache;
    private readonly inflight;
    private readonly ttlMs;
    private readonly now;
    constructor(loader: SheetLoader, options?: SheetCacheOptions);
    /** Drop what we know about a spreadsheet. Call after any structure change. */
    invalidate(spreadsheetId?: string): void;
    /** Feed the cache from a response a tool already had in hand. */
    prime(spreadsheetId: string, sheets: SheetInfo[]): SpreadsheetSheets;
    private fresh;
    /** Load the tab map, from cache when fresh. Concurrent callers share one load. */
    list(spreadsheetId: string, force?: boolean): Promise<SpreadsheetSheets>;
    /**
     * Resolve a tab name to its info, refreshing once on a miss so a tab created
     * moments ago is found rather than reported missing.
     */
    resolve(spreadsheetId: string, sheet: string): Promise<SheetInfo>;
    /** Resolve by numeric id, which is what an API response hands back. */
    resolveId(spreadsheetId: string, sheetId: number): Promise<SheetInfo | undefined>;
}
/** The `fields` mask that feeds `sheetInfoFromProperties`, kept next to it. */
export declare const SHEET_PROPERTIES_MASK = "sheets.properties(sheetId,title,index,sheetType,hidden,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount))";
/** Map one `Schema$SheetProperties` onto our smaller shape. */
export declare function sheetInfoFromProperties(properties: {
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
}): SheetInfo | undefined;
//# sourceMappingURL=sheetcache.d.ts.map