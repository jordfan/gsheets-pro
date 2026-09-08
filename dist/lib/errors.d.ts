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
export declare const ERROR_CODES: readonly ["auth_missing", "auth_expired", "unauthenticated", "permission_denied", "not_found", "sheet_not_found", "bad_range", "invalid_argument", "rate_limited", "quota_exceeded", "result_too_large", "contract_violation", "formula_guard", "ui_owned", "needs_confirmation", "unavailable", "internal"];
export type ErrorCode = (typeof ERROR_CODES)[number];
export interface StructuredError {
    code: ErrorCode;
    message: string;
    hint?: string;
    /** Extra machine readable context, for example the tabs that do exist. */
    details?: Record<string, unknown>;
}
export declare class GsheetsError extends Error {
    readonly code: ErrorCode;
    readonly hint?: string;
    readonly details?: Record<string, unknown>;
    constructor(code: ErrorCode, message: string, hint?: string, details?: Record<string, unknown>);
    toStructured(): StructuredError;
}
/** Shorthand constructors for the cases the tools raise by hand. */
export declare const err: {
    badRange: (range: string, why?: string) => GsheetsError;
    sheetNotFound: (name: string, available: string[]) => GsheetsError;
    invalid: (message: string, hint?: string) => GsheetsError;
    authMissing: (message: string, hint?: string) => GsheetsError;
    tooLarge: (message: string, hint?: string) => GsheetsError;
    internal: (message: string) => GsheetsError;
};
/** Pull the most specific message the Google client offers. */
export declare function apiErrorMessage(error: unknown): string;
/** The HTTP status, when the failure came from the API rather than from us. */
export declare function apiErrorStatus(error: unknown): number | undefined;
/**
 * Turn anything thrown into the structured shape, with a hint chosen by status.
 * A GsheetsError passes through untouched: it already knows its own hint.
 */
export declare function toStructuredError(error: unknown): StructuredError;
/** One line of prose for a structured error, for `content[0].text`. */
export declare function errorToText(e: StructuredError): string;
//# sourceMappingURL=errors.d.ts.map