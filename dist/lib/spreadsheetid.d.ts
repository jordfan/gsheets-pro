/**
 * Spreadsheet ids, and the URLs people paste instead of them.
 *
 * The commonest mistake against this API is pasting the whole browser URL
 * where the id belongs, which returns a 404 whose message says nothing useful.
 * The error hint already teaches the fix, but teaching is worse than simply
 * accepting the URL: a person copying a sheet out of their address bar is
 * doing the obvious thing, and so is a model that was handed that URL.
 *
 * So every tool that takes `spreadsheet_id` runs its argument through here
 * first. A bare id passes through untouched.
 */
/** True when the input looks like a URL rather than an id. */
export declare function looksLikeUrl(input: string): boolean;
/**
 * The spreadsheet id, from an id or from any Google Sheets URL.
 *
 * Anything that is neither is refused here rather than at the API, because a
 * refusal that says "this looks like a tab name" is worth more than a 404.
 */
export declare function resolveSpreadsheetId(input: string | undefined | null): string;
/** The sentence every `spreadsheet_id` description ends with. */
export declare const SPREADSHEET_ID_DESCRIPTION = "The spreadsheet id, the long id in the middle of the sheet's URL. A full URL works too and the id is read out of it.";
//# sourceMappingURL=spreadsheetid.d.ts.map