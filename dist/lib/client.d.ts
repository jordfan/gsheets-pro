/**
 * The shared context: Google clients, the tab cache, and the registry.
 *
 * All of this lives at module scope on purpose. In HTTP mode the SDK forces a
 * fresh transport and a fresh McpServer for every request, but the module stays
 * loaded, so the auth client and the tab cache survive between calls. Rebuilding
 * them per request would spend a read from a 60 per minute budget on every
 * single tool call.
 *
 * Resolution is lazy and only memoized on success. A server that cannot find a
 * credential should still start, list its tools, and explain itself when
 * called, rather than dying at boot with a stack trace nobody sees.
 */
import { drive_v3 } from "@googleapis/drive";
import { sheets_v4 } from "@googleapis/sheets";
import { type AuthState, type ResolveAuthOptions } from "./auth.js";
import { type Registry } from "./registry.js";
import { SheetCache, type SheetInfo } from "./sheetcache.js";
export interface Context {
    auth: AuthState;
    sheets: sheets_v4.Sheets;
    drive: drive_v3.Drive;
    cache: SheetCache;
    /** Undefined when the working directory is not inside a repo with a registry. */
    registry?: Registry;
}
export interface ContextOptions extends ResolveAuthOptions {
    /** Rebuild even if a context is already cached. */
    force?: boolean;
    /** Where to look for `.claude/gsheets-pro.json`. */
    cwd?: string;
}
/** Build, or return, the shared context. */
export declare function getContext(options?: ContextOptions): Promise<Context>;
/** Forget the cached context. Used by `doctor` and by the tests. */
export declare function resetContext(): void;
/** One masked `spreadsheets.get` that feeds the tab cache. */
export declare function loadSheetInfo(api: sheets_v4.Sheets, spreadsheetId: string): Promise<SheetInfo[]>;
//# sourceMappingURL=client.d.ts.map