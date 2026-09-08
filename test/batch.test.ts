/**
 * Retries and the one batchUpdate per call rule.
 *
 * Sleep and randomness are injected, so the suite runs instantly and the
 * backoff arithmetic is checked rather than waited out.
 */
import { describe, expect, test, vi } from "vitest";

import {
  backoffDelayMs,
  isRetryable,
  retryAfterMs,
  runBatchUpdate,
  withRetry,
  type BatchCapableSheets,
} from "../src/lib/batch.js";

function apiError(status: number, headers?: Record<string, string>) {
  return Object.assign(new Error(`status ${status}`), {
    response: { status, data: { error: { message: `status ${status}` } }, headers },
  });
}

const noSleep = { sleep: async () => {}, random: () => 0.5 };

describe("isRetryable", () => {
  test("429 and 5xx are", () => {
    expect(isRetryable(apiError(429))).toBe(true);
    expect(isRetryable(apiError(500))).toBe(true);
    expect(isRetryable(apiError(503))).toBe(true);
  });

  test("400, 403 and 404 are not, because retrying a bad request just wastes a minute", () => {
    expect(isRetryable(apiError(400))).toBe(false);
    expect(isRetryable(apiError(403))).toBe(false);
    expect(isRetryable(apiError(404))).toBe(false);
  });

  test("socket hangups are", () => {
    expect(isRetryable(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(true);
    expect(isRetryable(Object.assign(new Error("dns"), { code: "EAI_AGAIN" }))).toBe(true);
  });

  test("a plain Error is not", () => {
    expect(isRetryable(new Error("nope"))).toBe(false);
  });
});

describe("backoff", () => {
  test("doubles the window each attempt", () => {
    const opts = { random: () => 1, baseDelayMs: 500, maxDelayMs: 8000 };
    expect(backoffDelayMs(1, opts)).toBe(500);
    expect(backoffDelayMs(2, opts)).toBe(1000);
    expect(backoffDelayMs(3, opts)).toBe(2000);
    expect(backoffDelayMs(4, opts)).toBe(4000);
  });

  test("is capped", () => {
    expect(backoffDelayMs(20, { random: () => 1, maxDelayMs: 8000 })).toBe(8000);
  });

  test("jitters down to half the window, so parallel callers do not wake together", () => {
    expect(backoffDelayMs(3, { random: () => 0, baseDelayMs: 500 })).toBe(1000);
    expect(backoffDelayMs(3, { random: () => 1, baseDelayMs: 500 })).toBe(2000);
  });

  test("Retry-After wins over the computed delay", () => {
    expect(retryAfterMs(apiError(429, { "retry-after": "3" }))).toBe(3000);
    expect(retryAfterMs(apiError(429))).toBeUndefined();
  });
});

describe("withRetry", () => {
  test("returns the first success without sleeping", async () => {
    const sleep = vi.fn(async () => {});
    const result = await withRetry(async () => "done", { sleep });
    expect(result).toBe("done");
    expect(sleep).not.toHaveBeenCalled();
  });

  test("retries a 429 and then succeeds", async () => {
    let calls = 0;
    const sleep = vi.fn(async () => {});
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw apiError(429);
        return calls;
      },
      { ...noSleep, sleep },
    );
    expect(result).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  test("gives up after the retry budget and rethrows the last failure", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw apiError(503);
        },
        { ...noSleep, retries: 2 },
      ),
    ).rejects.toThrow(/status 503/);
    expect(calls).toBe(3);
  });

  test("does not retry a 400", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw apiError(400);
        },
        noSleep,
      ),
    ).rejects.toThrow(/status 400/);
    expect(calls).toBe(1);
  });

  test("honours Retry-After when the API sends one", async () => {
    const waits: number[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw apiError(429, { "retry-after": "2" });
        return "ok";
      },
      {
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    expect(waits).toEqual([2000]);
  });

  test("reports each retry", async () => {
    const seen: number[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw apiError(500);
        return "ok";
      },
      { ...noSleep, onRetry: (info) => seen.push(info.attempt) },
    );
    expect(seen).toEqual([1]);
  });
});

describe("runBatchUpdate", () => {
  function fakeApi(): BatchCapableSheets & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      calls,
      spreadsheets: {
        async batchUpdate(params) {
          calls.push(params);
          return { data: { replies: [] } };
        },
      },
    };
  }

  test("sends every request in exactly one call", async () => {
    const api = fakeApi();
    const result = await runBatchUpdate(api, "sheet-id", [{ a: 1 }, { b: 2 }, { c: 3 }]);
    expect(api.calls).toHaveLength(1);
    expect(result.requestCount).toBe(3);
  });

  test("refuses an empty request list rather than burning a call", async () => {
    const api = fakeApi();
    await expect(runBatchUpdate(api, "sheet-id", [])).rejects.toThrow(/no changes/);
    expect(api.calls).toHaveLength(0);
  });

  test("dry run sends nothing and reports what it would have sent", async () => {
    const api = fakeApi();
    const result = await runBatchUpdate(api, "sheet-id", [{ a: 1 }], { dryRun: true });
    expect(api.calls).toHaveLength(0);
    expect(result.response).toEqual({ dryRun: true, requests: [{ a: 1 }] });
  });

  test("optional response fields are only sent when asked for", async () => {
    const api = fakeApi();
    await runBatchUpdate(api, "id", [{ a: 1 }]);
    expect(api.calls[0]).toEqual({ spreadsheetId: "id", requestBody: { requests: [{ a: 1 }] } });

    await runBatchUpdate(api, "id", [{ a: 1 }], {
      includeSpreadsheetInResponse: true,
      responseRanges: ["Tracker!A1:B2"],
    });
    expect(api.calls[1]).toMatchObject({
      requestBody: { includeSpreadsheetInResponse: true, responseRanges: ["Tracker!A1:B2"] },
    });
  });

  test("a rate limited batch is retried, still as one logical call", async () => {
    let attempts = 0;
    const api: BatchCapableSheets = {
      spreadsheets: {
        async batchUpdate() {
          attempts += 1;
          if (attempts === 1) throw apiError(429);
          return { data: { ok: true } };
        },
      },
    };
    const result = await runBatchUpdate(api, "id", [{ a: 1 }], noSleep);
    expect(attempts).toBe(2);
    expect(result.requestCount).toBe(1);
  });
});
