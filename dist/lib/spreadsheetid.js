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
import { GsheetsError } from "./errors.js";
/** Google's own id shape: 20 or more of these characters. */
const ID_PATTERN = /^[A-Za-z0-9_-]{20,}$/;
/** `/spreadsheets/d/<id>/` and the `?id=` form older links still use. */
const URL_PATTERNS = [
    /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/,
    /\/file\/d\/([A-Za-z0-9_-]{20,})/,
    /[?&]id=([A-Za-z0-9_-]{20,})/,
];
/** True when the input looks like a URL rather than an id. */
export function looksLikeUrl(input) {
    return /^https?:\/\//i.test(String(input ?? "").trim()) || input.includes("docs.google.com");
}
/**
 * The spreadsheet id, from an id or from any Google Sheets URL.
 *
 * Anything that is neither is refused here rather than at the API, because a
 * refusal that says "this looks like a tab name" is worth more than a 404.
 */
export function resolveSpreadsheetId(input) {
    const raw = String(input ?? "").trim();
    if (!raw) {
        throw new GsheetsError("invalid_argument", "spreadsheet_id is required.", "Pass the long id from the middle of the sheet's URL, or paste the whole URL and it will be read out of it.");
    }
    if (ID_PATTERN.test(raw) && !looksLikeUrl(raw))
        return raw;
    for (const pattern of URL_PATTERNS) {
        const match = pattern.exec(raw);
        if (match?.[1])
            return match[1];
    }
    if (looksLikeUrl(raw)) {
        throw new GsheetsError("invalid_argument", `No spreadsheet id in "${truncate(raw)}".`, "A Google Sheets URL looks like https://docs.google.com/spreadsheets/d/<id>/edit. This one has no /spreadsheets/d/ part, so it may be a Drive folder or a different kind of document.");
    }
    throw new GsheetsError("invalid_argument", `"${truncate(raw)}" is not a spreadsheet id.`, "An id is the long run of letters, digits, hyphens and underscores in the middle of the sheet's URL. A full URL works too. A tab name goes in the sheet argument instead.");
}
function truncate(value, max = 60) {
    return value.length <= max ? value : `${value.slice(0, max)}...`;
}
/** The sentence every `spreadsheet_id` description ends with. */
export const SPREADSHEET_ID_DESCRIPTION = "The spreadsheet id, the long id in the middle of the sheet's URL. A full URL works too and the id is read out of it.";
//# sourceMappingURL=spreadsheetid.js.map