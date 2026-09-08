/**
 * The live suites' quota pacer, tested offline.
 *
 * It is the one piece of test infrastructure that can hang a run rather than
 * fail it, so the bucket's arithmetic is worth pinning down here rather than
 * discovering at three minutes into a live suite.
 */
import { describe, expect, test } from "vitest";

import {
  callsThisWindow,
  createBucket,
  MAX_CALLS_PER_WINDOW,
  paceContext,
  WINDOW_MS,
  WRAPPER_RETRIES,
} from "./live/pacing.js";
import type { Context } from "../src/lib/client.js";
import { sheets as sheetsClient } from "@googleapis/sheets";

/** A clock and a sleep that move together, so no test actually waits. */
function fakeClock(start = 1_000_000) {
  let now = start;
  const slept: number[] = [];
  return {
    now: () => now,
    slept,
    sleep: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("the token bucket", () => {
  test("lets calls through while there is room", async () => {
    const clock = fakeClock();
    const bucket = createBucket(3, 1000, clock.now, clock.sleep);

    await bucket.take();
    await bucket.take();
    await bucket.take();

    expect(clock.slept).toEqual([]);
    expect(bucket.inFlightWindow).toBe(3);
  });

  test("waits when the window is full, and only as long as it must", async () => {
    const clock = fakeClock();
    const bucket = createBucket(2, 1000, clock.now, clock.sleep);

    await bucket.take();
    clock.advance(400);
    await bucket.take();

    // The third has to wait for the first to fall out of the window, which is
    // 600ms away, plus the small margin the bucket adds.
    await bucket.take();
    expect(clock.slept).toHaveLength(1);
    expect(clock.slept[0]).toBeGreaterThanOrEqual(600);
    expect(clock.slept[0]).toBeLessThan(700);
  });

  test("a call that has aged out of the window frees its slot", async () => {
    const clock = fakeClock();
    const bucket = createBucket(1, 1000, clock.now, clock.sleep);

    await bucket.take();
    clock.advance(1500);
    await bucket.take();

    expect(clock.slept).toEqual([]);
    expect(bucket.inFlightWindow).toBe(1);
  });

  test("a long run settles to the rate rather than stalling", async () => {
    const clock = fakeClock();
    const bucket = createBucket(5, 1000, clock.now, clock.sleep);

    for (let i = 0; i < 20; i += 1) await bucket.take();

    // Twenty calls at five per second is four windows, so about three of them
    // are spent waiting. The point is that it finishes at all.
    const waited = clock.slept.reduce((a, b) => a + b, 0);
    expect(waited).toBeGreaterThan(2_000);
    expect(waited).toBeLessThan(5_000);
    expect(bucket.inFlightWindow).toBeLessThanOrEqual(5);
  });
});

describe("the paced client", () => {
  function fakeContext(calls: string[]): Context {
    const sheets = {
      spreadsheets: {
        async get(params: { spreadsheetId: string }) {
          calls.push(`get:${params.spreadsheetId}`);
          return { data: { spreadsheetId: params.spreadsheetId } };
        },
        values: {
          async batchGet(params: { ranges: string[] }) {
            calls.push(`batchGet:${params.ranges.join(",")}`);
            return { data: { valueRanges: [] } };
          },
        },
      },
    };
    return { sheets, drive: {} } as unknown as Context;
  }

  const noWait = { take: async () => {} };

  test("reaches methods nested two levels down", async () => {
    const calls: string[] = [];
    const paced = paceContext(fakeContext(calls), noWait);

    await paced.sheets.spreadsheets.values.batchGet({ ranges: ["A1:B2"] } as never);
    expect(calls).toEqual(["batchGet:A1:B2"]);
  });

  test("passes arguments and returns the client's own result", async () => {
    const calls: string[] = [];
    const paced = paceContext(fakeContext(calls), noWait);

    const response = await paced.sheets.spreadsheets.get({ spreadsheetId: "abc" } as never);
    expect(response.data.spreadsheetId).toBe("abc");
    expect(calls).toEqual(["get:abc"]);
  });

  test("takes a token for every call, including the ones a tool makes", async () => {
    const calls: string[] = [];
    let tokens = 0;
    const counting = {
      take: async () => {
        tokens += 1;
      },
    };
    const paced = paceContext(fakeContext(calls), counting);

    await paced.sheets.spreadsheets.get({ spreadsheetId: "a" } as never);
    await paced.sheets.spreadsheets.values.batchGet({ ranges: ["A1"] } as never);
    await paced.sheets.spreadsheets.get({ spreadsheetId: "b" } as never);

    expect(tokens).toBe(3);
  });

  test("retries a transient failure rather than surfacing it as an assertion error", async () => {
    let attempts = 0;
    const flaky = {
      sheets: {
        spreadsheets: {
          async get() {
            attempts += 1;
            if (attempts < 2) {
              throw Object.assign(new Error("Quota exceeded"), { code: 429 });
            }
            return { data: { ok: true } };
          },
        },
      },
      drive: {},
    } as unknown as Context;

    const paced = paceContext(flaky, noWait);
    const response = await (paced.sheets.spreadsheets.get as unknown as () => Promise<unknown>)();

    expect(attempts).toBe(2);
    expect(response).toEqual({ data: { ok: true } });
  });

  test("a real failure still fails, and does not retry forever", async () => {
    let attempts = 0;
    const broken = {
      sheets: {
        spreadsheets: {
          async get() {
            attempts += 1;
            throw Object.assign(new Error("Bad range"), { code: 400 });
          },
        },
      },
      drive: {},
    } as unknown as Context;

    const paced = paceContext(broken, noWait);
    await expect(
      (paced.sheets.spreadsheets.get as unknown as () => Promise<unknown>)(),
    ).rejects.toThrow(/Bad range/);
    // A 400 is a bug in the request, so it is not retried at all.
    expect(attempts).toBe(1);
  });

  test("leaves everything that is not a function alone", async () => {
    const context = {
      sheets: { spreadsheets: { context: { _options: { version: "v4" } } } },
      drive: {},
    } as unknown as Context;
    const paced = paceContext(context, noWait);
    expect(
      (paced.sheets.spreadsheets as unknown as { context: { _options: { version: string } } }).context
        ._options.version,
    ).toBe("v4");
  });
});

describe("the settings the live suites run under", () => {
  test("stay under the sixty a minute Sheets allows", () => {
    expect(WINDOW_MS).toBe(60_000);
    expect(MAX_CALLS_PER_WINDOW).toBeLessThan(60);
  });

  test("add few enough retries that a spent quota fails promptly", () => {
    // The tools retry four times on their own. A wrapper that also retried
    // four times would turn an exhausted quota into many minutes of backoff.
    expect(WRAPPER_RETRIES).toBeLessThanOrEqual(2);
  });

  test("the shared bucket is readable, so a run can report what it spent", () => {
    expect(typeof callsThisWindow()).toBe("number");
  });
});

describe("wrapping the real generated client", () => {
  /**
   * The fakes elsewhere in this file are plain objects, and a plain object's
   * properties are configurable, so they cannot catch this. The generated
   * Sheets client defines `spreadsheets` as writable: false and
   * configurable: false, and the language forbids a proxy from answering a read
   * of such a property with anything but the stored value. Proxying the client
   * itself therefore threw a TypeError on the first `ctx.sheets.spreadsheets`,
   * before any request was made, and took every live suite down with it. The
   * pacer proxies an empty object and closes over the client instead.
   */
  test("reaches through a non-configurable property instead of throwing", () => {
    const client = sheetsClient({ version: "v4" });
    const descriptor = Object.getOwnPropertyDescriptor(client, "spreadsheets");
    expect(descriptor?.configurable).toBe(false);
    expect(descriptor?.writable).toBe(false);

    const context = { sheets: client, drive: {} } as unknown as Context;
    const paced = paceContext(context, { take: async () => {} });

    expect(() => paced.sheets.spreadsheets).not.toThrow();
    expect(typeof paced.sheets.spreadsheets.values.get).toBe("function");
    expect(typeof paced.sheets.spreadsheets.developerMetadata.search).toBe("function");
  });

  test("the paced method is a wrapper, not the client's own function", () => {
    const client = sheetsClient({ version: "v4" });
    const context = { sheets: client, drive: {} } as unknown as Context;
    const paced = paceContext(context, { take: async () => {} });
    expect(paced.sheets.spreadsheets.get).not.toBe(client.spreadsheets.get);
  });
});
