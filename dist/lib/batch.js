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
import { apiErrorMessage, apiErrorStatus } from "./errors.js";
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** 429 and 5xx are worth retrying. So are the socket level hangups. */
export function isRetryable(error) {
    const status = apiErrorStatus(error);
    if (status === 429)
        return true;
    if (status !== undefined && status >= 500 && status < 600)
        return true;
    const code = error?.code;
    if (typeof code === "string") {
        return ["ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(code);
    }
    return false;
}
/** Honour a Retry-After header when the API sends one, in milliseconds. */
export function retryAfterMs(error) {
    const headers = error?.response
        ?.headers;
    if (!headers)
        return undefined;
    const raw = headers["retry-after"] ?? headers["Retry-After"];
    if (raw === undefined || raw === null)
        return undefined;
    const seconds = Number(Array.isArray(raw) ? raw[0] : raw);
    if (Number.isFinite(seconds) && seconds >= 0)
        return Math.round(seconds * 1000);
    const when = Date.parse(String(raw));
    if (Number.isFinite(when))
        return Math.max(0, when - Date.now());
    return undefined;
}
/**
 * Exponential backoff with full jitter: wait a random slice of the window
 * rather than the whole thing, so parallel callers do not all wake together.
 */
export function backoffDelayMs(attempt, options = {}) {
    const base = options.baseDelayMs ?? 500;
    const max = options.maxDelayMs ?? 8000;
    const random = options.random ?? Math.random;
    const window = Math.min(max, base * Math.pow(2, Math.max(0, attempt - 1)));
    return Math.round(window * (0.5 + 0.5 * random()));
}
/** Run an API call, retrying the transient failures. */
export async function withRetry(fn, options = {}) {
    const retries = options.retries ?? 4;
    const sleep = options.sleep ?? defaultSleep;
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return await fn();
        }
        catch (error) {
            lastError = error;
            if (attempt === retries || !isRetryable(error))
                throw error;
            const delayMs = retryAfterMs(error) ?? backoffDelayMs(attempt + 1, options);
            options.onRetry?.({ attempt: attempt + 1, delayMs, message: apiErrorMessage(error) });
            await sleep(delayMs);
        }
    }
    throw lastError;
}
/** Send one batchUpdate carrying every request the tool assembled. */
export async function runBatchUpdate(api, spreadsheetId, requests, options = {}) {
    if (!Array.isArray(requests) || requests.length === 0) {
        throw new Error("Nothing to do: the call produced no changes.");
    }
    if (options.dryRun) {
        return { requestCount: requests.length, response: { dryRun: true, requests } };
    }
    const body = { requests };
    if (options.includeSpreadsheetInResponse)
        body.includeSpreadsheetInResponse = true;
    if (options.responseRanges)
        body.responseRanges = options.responseRanges;
    if (options.responseIncludeGridData)
        body.responseIncludeGridData = true;
    const res = await withRetry(() => api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: body }), options);
    return { requestCount: requests.length, response: res.data };
}
//# sourceMappingURL=batch.js.map