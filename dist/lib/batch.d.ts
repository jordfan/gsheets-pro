/**
 * One batchUpdate per call, with backoff.
 *
 * Sheets counts a batchUpdate once no matter how many requests it carries, and
 * the per user quota is 60 writes a minute. So every tool assembles all of its
 * work into a single request list and sends it once: it is faster, it is
 * cheaper against quota, and it is atomic, which means a tool either applies
 * its whole change or none of it.
 *
 * Retries cover 429 and the 5xx family only. A 400 is a bug in the request and
 * retrying it just wastes a minute.
 */
export interface RetryOptions {
    /** Attempts after the first. Default 4, which spans roughly 15 seconds. */
    retries?: number;
    /** First backoff step in milliseconds. Default 500. */
    baseDelayMs?: number;
    /** Ceiling for a single wait. Default 8000. */
    maxDelayMs?: number;
    /** Injectable for tests. */
    sleep?: (ms: number) => Promise<void>;
    /** Injectable for tests. Returns 0..1. */
    random?: () => number;
    /** Called before each wait, for logging. */
    onRetry?: (info: {
        attempt: number;
        delayMs: number;
        message: string;
    }) => void;
}
/** 429 and 5xx are worth retrying. So are the socket level hangups. */
export declare function isRetryable(error: unknown): boolean;
/** Honour a Retry-After header when the API sends one, in milliseconds. */
export declare function retryAfterMs(error: unknown): number | undefined;
/**
 * Exponential backoff with full jitter: wait a random slice of the window
 * rather than the whole thing, so parallel callers do not all wake together.
 */
export declare function backoffDelayMs(attempt: number, options?: RetryOptions): number;
/** Run an API call, retrying the transient failures. */
export declare function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T>;
/**
 * The narrow slice of the Sheets client the batch helper needs. Typing it
 * structurally keeps this file testable with a fake and keeps the generated
 * client's enormous types out of the unit tests.
 */
export interface BatchCapableSheets {
    spreadsheets: {
        batchUpdate(params: {
            spreadsheetId: string;
            requestBody: {
                requests: unknown[];
                includeSpreadsheetInResponse?: boolean;
                responseRanges?: string[];
                responseIncludeGridData?: boolean;
            };
        }): Promise<{
            data: unknown;
        }>;
    };
}
export interface BatchResult {
    /** How many requests went in the one batchUpdate. */
    requestCount: number;
    /** The raw `BatchUpdateSpreadsheetResponse`. */
    response: unknown;
}
export interface BatchOptions extends RetryOptions {
    /** Return the spreadsheet in the response, for the tools that need it back. */
    includeSpreadsheetInResponse?: boolean;
    responseRanges?: string[];
    responseIncludeGridData?: boolean;
    /** Skip the call and report what would have been sent. */
    dryRun?: boolean;
}
/** Send one batchUpdate carrying every request the tool assembled. */
export declare function runBatchUpdate(api: BatchCapableSheets, spreadsheetId: string, requests: unknown[], options?: BatchOptions): Promise<BatchResult>;
//# sourceMappingURL=batch.d.ts.map