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
import { drive } from "@googleapis/drive";
import { sheets } from "@googleapis/sheets";
import { resolveAuth } from "./auth.js";
import { loadRegistry } from "./registry.js";
import { SheetCache, SHEET_PROPERTIES_MASK, sheetInfoFromProperties } from "./sheetcache.js";
import { withRetry } from "./batch.js";
let cached;
let inflight;
/** Build, or return, the shared context. */
export async function getContext(options = {}) {
    if (cached && !options.force)
        return cached;
    if (inflight && !options.force)
        return inflight;
    const build = (async () => {
        const auth = await resolveAuth(options);
        // The generated clients accept any auth client the library produces.
        const authClient = auth.client;
        const context = {
            auth,
            sheets: sheets({ version: "v4", auth: authClient }),
            drive: drive({ version: "v3", auth: authClient }),
            cache: new SheetCache(() => {
                throw new Error("sheet loader not wired");
            }),
            registry: loadRegistry({ cwd: options.cwd }),
        };
        // The cache needs the client the context holds, so it is wired after.
        context.cache = new SheetCache((spreadsheetId) => loadSheetInfo(context.sheets, spreadsheetId));
        cached = context;
        return context;
    })();
    inflight = build;
    try {
        return await build;
    }
    finally {
        inflight = undefined;
    }
}
/** Forget the cached context. Used by `doctor` and by the tests. */
export function resetContext() {
    cached = undefined;
    inflight = undefined;
}
/** One masked `spreadsheets.get` that feeds the tab cache. */
export async function loadSheetInfo(api, spreadsheetId) {
    const res = await withRetry(() => api.spreadsheets.get({ spreadsheetId, fields: SHEET_PROPERTIES_MASK }));
    const out = [];
    for (const sheet of res.data.sheets ?? []) {
        const info = sheet.properties ? sheetInfoFromProperties(sheet.properties) : undefined;
        if (info)
            out.push(info);
    }
    return out;
}
//# sourceMappingURL=client.js.map