/**
 * Structured errors.
 *
 * Every failure a tool returns is `{ code, message, hint }` with `isError:
 * true`. The code is for the model to branch on, the message says what went
 * wrong, and the hint teaches the fix in one sentence. The hints are the part
 * that matters: a 404 from Sheets means almost every time that someone pasted a
 * whole URL where an id belongs, and saying so is worth more than the API's own
 * wording.
 */
export const ERROR_CODES = [
    "auth_missing",
    "auth_expired",
    "unauthenticated",
    "permission_denied",
    "not_found",
    "sheet_not_found",
    "bad_range",
    "invalid_argument",
    "rate_limited",
    "quota_exceeded",
    "result_too_large",
    "contract_violation",
    "formula_guard",
    "ui_owned",
    "needs_confirmation",
    "unavailable",
    "internal",
];
export class GsheetsError extends Error {
    code;
    hint;
    details;
    constructor(code, message, hint, details) {
        super(message);
        this.name = "GsheetsError";
        this.code = code;
        this.hint = hint;
        this.details = details;
    }
    toStructured() {
        const out = { code: this.code, message: this.message };
        if (this.hint)
            out.hint = this.hint;
        if (this.details)
            out.details = this.details;
        return out;
    }
}
/** Shorthand constructors for the cases the tools raise by hand. */
export const err = {
    badRange: (range, why) => new GsheetsError("bad_range", why ?? `Could not parse the range "${range}".`, "Ranges are A1: a cell like B2, a block like A1:C10, a whole column like B:B, or a whole row like 3:3. A tab name goes in the sheet argument, not the range."),
    sheetNotFound: (name, available) => new GsheetsError("sheet_not_found", `No tab named "${name}" in this spreadsheet.`, available.length
        ? `The tabs are: ${available.join(", ")}. Tab names are matched without regard to case.`
        : "This spreadsheet has no readable tabs. Check that the account can open it.", { available }),
    invalid: (message, hint) => new GsheetsError("invalid_argument", message, hint),
    authMissing: (message, hint) => new GsheetsError("auth_missing", message, hint ??
        "Run `gsheets-pro auth` to sign in, or `gsheets-pro doctor` to see which credential the server found."),
    tooLarge: (message, hint) => new GsheetsError("result_too_large", message, hint),
    internal: (message) => new GsheetsError("internal", message),
};
/** Pull the most specific message the Google client offers. */
export function apiErrorMessage(error) {
    if (error instanceof GsheetsError)
        return error.message;
    if (error instanceof Error && !error.response)
        return error.message;
    if (error && typeof error === "object") {
        const e = error;
        return (e.response?.data?.error?.message ||
            e.errors?.[0]?.message ||
            e.message ||
            String(error));
    }
    return String(error);
}
/** The HTTP status, when the failure came from the API rather than from us. */
export function apiErrorStatus(error) {
    if (!error || typeof error !== "object")
        return undefined;
    const e = error;
    const raw = e.response?.status ?? e.response?.data?.error?.code ?? e.status ?? e.code;
    const n = typeof raw === "string" ? Number(raw) : raw;
    return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}
/**
 * Turn anything thrown into the structured shape, with a hint chosen by status.
 * A GsheetsError passes through untouched: it already knows its own hint.
 */
export function toStructuredError(error) {
    if (error instanceof GsheetsError)
        return error.toStructured();
    const message = apiErrorMessage(error);
    const status = apiErrorStatus(error);
    // A refused token refresh arrives as a 400 from the OAuth endpoint, not from
    // the Sheets API, so it has to be caught before the generic 400 branch. Left
    // there it produces "check your tab names and A1 ranges", which sends the
    // reader looking at the spreadsheet when the problem is the credential.
    if (/invalid_grant|invalid_rapt|reauth|Token has been expired or revoked/i.test(message)) {
        const reauth = /invalid_rapt|reauth/i.test(message);
        return {
            code: "auth_expired",
            message,
            hint: reauth
                ? "Google wants the sign in repeated. For Application Default Credentials run `gcloud auth application-default login --scopes=https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/drive.file`. For a token file run `gsheets-pro auth`."
                : "The refresh token is no longer valid. Run `gsheets-pro auth` to sign in again. A refresh token also dies after seven days while the OAuth consent screen is still in Testing.",
        };
    }
    if (status === 404 || /NOT_FOUND/.test(message)) {
        return {
            code: "not_found",
            message,
            hint: "Check the spreadsheet id. It is the long id in the middle of the sheet's URL, not the whole URL.",
        };
    }
    if (status === 401 || /UNAUTHENTICATED/.test(message)) {
        return {
            code: "unauthenticated",
            message,
            hint: "The token was rejected. Run `gsheets-pro doctor`, then `gsheets-pro auth` to sign in again. A token from an app still in Testing expires after seven days.",
        };
    }
    if (status === 403 && /(quota|rate limit)/i.test(message)) {
        return {
            code: "quota_exceeded",
            message,
            hint: "Sheets allows 60 reads and 60 writes a minute per user. Wait a minute, and batch the work into fewer calls.",
        };
    }
    if (status === 403 || /PERMISSION_DENIED/.test(message)) {
        return {
            code: "permission_denied",
            message,
            hint: "This account can reach the API but not this spreadsheet. Check that it has edit access, and that the token carries the spreadsheets scope.",
        };
    }
    if (status === 429 || /RESOURCE_EXHAUSTED/.test(message)) {
        return {
            code: "rate_limited",
            message,
            hint: "Sheets allows 60 reads and 60 writes a minute per user. The server already retried with backoff, so the quota is genuinely spent. Wait a minute.",
        };
    }
    if (status === 400 || /INVALID_ARGUMENT/.test(message)) {
        return {
            code: "invalid_argument",
            message,
            hint: "The API refused the request as written. Check tab names, A1 ranges, and that the range exists inside the sheet's current grid.",
        };
    }
    if (status !== undefined && status >= 500) {
        return {
            code: "unavailable",
            message,
            hint: "Google returned a server error. This is usually transient, so try the same call again.",
        };
    }
    return { code: "internal", message };
}
/** One line of prose for a structured error, for `content[0].text`. */
export function errorToText(e) {
    return e.hint ? `Error (${e.code}): ${e.message}\n\n${e.hint}` : `Error (${e.code}): ${e.message}`;
}
//# sourceMappingURL=errors.js.map