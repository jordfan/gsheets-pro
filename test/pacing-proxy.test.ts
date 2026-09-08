/**
 * The live suites' quota pacing, tested offline.
 *
 * The helper itself lives under `test/live` because that is who uses it, but it
 * needs a test that runs without credentials, for one reason: its failure mode
 * is a `TypeError` thrown on the first property access, which means nobody
 * finds out until they run a live suite and the whole file reports as skipped.
 *
 * The regression is specific and worth naming. `@googleapis/sheets` defines
 * `spreadsheets` as a non-configurable, non-writable own property. A proxy whose
 * target carries such a property must return that exact value from its `get`
 * trap, so a wrapper throws rather than pacing anything.
 */

import { describe, expect, test } from "vitest";

import { createBucket, paceContext } from "./live/pacing.js";
import type { Context } from "../src/lib/client.js";

/** A client shaped like the generated Google one, locked down the same way. */
function frozenClient(calls: string[]): { spreadsheets: Record<string, unknown> } {
  const spreadsheets = {
    async get(params: { spreadsheetId: string }) {
      calls.push(`get:${params.spreadsheetId}`);
      return { data: { spreadsheetId: params.spreadsheetId } };
    },
    values: {
      async batchGet() {
        calls.push("batchGet");
        return { data: { valueRanges: [] } };
      },
    },
  };

  const client = {};
  Object.defineProperty(client, "spreadsheets", {
    value: spreadsheets,
    writable: false,
    configurable: false,
    enumerable: true,
  });
  return client as { spreadsheets: Record<string, unknown> };
}

function contextWith(client: object): Context {
  return { sheets: client, drive: {} } as unknown as Context;
}

describe("paceContext", () => {
  test("reaches through a non-configurable property instead of throwing", async () => {
    const calls: string[] = [];
    const ctx = paceContext(contextWith(frozenClient(calls)));

    // The line that used to throw: TypeError, 'get' on proxy, read-only and
    // non-configurable data property.
    const api = ctx.sheets.spreadsheets as unknown as {
      get(p: { spreadsheetId: string }): Promise<{ data: { spreadsheetId: string } }>;
    };
    const response = await api.get({ spreadsheetId: "abc" });

    expect(response.data.spreadsheetId).toBe("abc");
    expect(calls).toEqual(["get:abc"]);
  });

  test("paces nested resources too, not only the first level", async () => {
    const calls: string[] = [];
    const ctx = paceContext(contextWith(frozenClient(calls)));
    const values = (ctx.sheets.spreadsheets as unknown as { values: { batchGet(): Promise<unknown> } })
      .values;
    await values.batchGet();
    expect(calls).toEqual(["batchGet"]);
  });

  test("every call goes through the limiter", async () => {
    const calls: string[] = [];
    let taken = 0;
    const limiter = {
      async take() {
        taken += 1;
      },
    };
    const ctx = paceContext(contextWith(frozenClient(calls)), limiter);
    const api = ctx.sheets.spreadsheets as unknown as {
      get(p: { spreadsheetId: string }): Promise<unknown>;
    };
    await api.get({ spreadsheetId: "one" });
    await api.get({ spreadsheetId: "two" });
    expect(taken).toBe(2);
  });

  test("the wrapped client still enumerates", () => {
    const ctx = paceContext(contextWith(frozenClient([])));
    expect("spreadsheets" in ctx.sheets).toBe(true);
    expect(Object.keys(ctx.sheets)).toContain("spreadsheets");
  });
});

describe("the token bucket", () => {
  test("lets calls through up to the limit without waiting", async () => {
    let now = 0;
    const slept: number[] = [];
    const bucket = createBucket(
      3,
      1000,
      () => now,
      async (ms) => {
        slept.push(ms);
        now += ms;
      },
    );

    for (let i = 0; i < 3; i += 1) await bucket.take();
    expect(slept).toEqual([]);
    expect(bucket.inFlightWindow).toBe(3);
  });

  test("waits exactly long enough for the oldest call to leave the window", async () => {
    let now = 0;
    const slept: number[] = [];
    const bucket = createBucket(
      2,
      1000,
      () => now,
      async (ms) => {
        slept.push(ms);
        now += ms;
      },
    );

    await bucket.take();
    now = 400;
    await bucket.take();
    now = 500;
    await bucket.take();

    // The oldest call was at 0 and the window is 1000, so at 500 there are 500
    // milliseconds left on it, plus the helper's small margin.
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThanOrEqual(500);
    expect(slept[0]).toBeLessThan(700);
  });
});
