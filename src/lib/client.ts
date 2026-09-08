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

import { drive_v3, drive } from "@googleapis/drive";
import { sheets_v4, sheets } from "@googleapis/sheets";

import { resolveAuth, type AuthState, type ResolveAuthOptions } from "./auth.js";
import { loadRegistry, type Registry } from "./registry.js";
import { SheetCache, SHEET_PROPERTIES_MASK, sheetInfoFromProperties, type SheetInfo } from "./sheetcache.js";
import { withRetry } from "./batch.js";

export interface Context {
  auth: AuthState;
  sheets: sheets_v4.Sheets;
  drive: drive_v3.Drive;
  cache: SheetCache;
  /** Undefined when the working directory is not inside a repo with a registry. */
  registry?: Registry;
}

let cached: Context | undefined;
let inflight: Promise<Context> | undefined;

export interface ContextOptions extends ResolveAuthOptions {
  /** Rebuild even if a context is already cached. */
  force?: boolean;
  /** Where to look for `.claude/gsheets-pro.json`. */
  cwd?: string;
}

/** Build, or return, the shared context. */
export async function getContext(options: ContextOptions = {}): Promise<Context> {
  if (cached && !options.force) return cached;
  if (inflight && !options.force) return inflight;

  const build = (async () => {
    const auth = await resolveAuth(options);
    // The generated clients accept any auth client the library produces.
    const authClient = auth.client as never;
    const context: Context = {
      auth,
      sheets: sheets({ version: "v4", auth: authClient }),
      drive: drive({ version: "v3", auth: authClient }),
      cache: new SheetCache(() => {
        throw new Error("sheet loader not wired");
      }),
      registry: loadRegistry({ cwd: options.cwd }),
    };
    // The cache needs the client the context holds, so it is wired after.
    (context as { cache: SheetCache }).cache = new SheetCache((spreadsheetId) =>
      loadSheetInfo(context.sheets, spreadsheetId),
    );
    cached = context;
    return context;
  })();

  inflight = build;
  try {
    return await build;
  } finally {
    inflight = undefined;
  }
}

/** Forget the cached context. Used by `doctor` and by the tests. */
export function resetContext(): void {
  cached = undefined;
  inflight = undefined;
}

/** One masked `spreadsheets.get` that feeds the tab cache. */
export async function loadSheetInfo(
  api: sheets_v4.Sheets,
  spreadsheetId: string,
): Promise<SheetInfo[]> {
  const res = await withRetry(() =>
    api.spreadsheets.get({ spreadsheetId, fields: SHEET_PROPERTIES_MASK }),
  );
  const out: SheetInfo[] = [];
  for (const sheet of res.data.sheets ?? []) {
    const info = sheet.properties ? sheetInfoFromProperties(sheet.properties) : undefined;
    if (info) out.push(info);
  }
  return out;
}
