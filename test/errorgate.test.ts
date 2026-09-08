/**
 * The error gate. All ids and names here are invented.
 */
import { describe, expect, test } from "vitest";

import {
  describeCheck,
  runErrorGate,
  withinGateCap,
  type GateCapableSheets,
} from "../src/lib/errorgate.js";

interface FakeCell {
  formula?: boolean;
  error?: string;
}

/** A tiny grid: rows of cells, so a test can place an error at a known A1. */
function fakeApi(sheets: Record<string, FakeCell[][]>, secondRead?: Record<string, FakeCell[][]>) {
  let reads = 0;
  const api: GateCapableSheets & { reads: () => number; ranges: string[][] } = {
    ranges: [],
    reads: () => reads,
    spreadsheets: {
      async get(params: { ranges?: string[] }) {
        reads += 1;
        api.ranges.push(params.ranges ?? []);
        const source = reads > 1 && secondRead ? secondRead : sheets;
        return {
          data: {
            sheets: Object.entries(source).map(([title, rows]) => ({
              properties: { title },
              data: [
                {
                  startRow: 0,
                  startColumn: 0,
                  rowData: rows.map((row) => ({
                    values: row.map((cell) => ({
                      ...(cell.formula ? { userEnteredValue: { formulaValue: "=A1" } } : {}),
                      ...(cell.error ? { effectiveValue: { errorValue: { type: cell.error, message: "m" } } } : {}),
                    })),
                  })),
                },
              ],
            })),
          },
        };
      },
    },
  };
  return api;
}

const noSleep = async () => {};

describe("runErrorGate", () => {
  test("no ranges is skipped, not ok", async () => {
    const api = fakeApi({});
    const check = await runErrorGate(api, "sheet-id", []);
    expect(check.status).toBe("skipped");
    expect(api.reads()).toBe(0);
    expect(check.note).toContain("nothing was checked");
  });

  test("counts formulas and reports a clean sheet", async () => {
    const api = fakeApi({ Roster: [[{ formula: true }, {}], [{ formula: true }, {}]] });
    const check = await runErrorGate(api, "sheet-id", ["'Roster'!A1:B2"]);
    expect(check.status).toBe("ok");
    expect(check.total_formulas).toBe(2);
    expect(check.total_errors).toBe(0);
    expect(describeCheck(check)).toContain("clean");
  });

  test("keys the summary on ErrorValue.type and names the cell", async () => {
    const api = fakeApi({
      Roster: [
        [{}, {}],
        [{ formula: true, error: "REF" }, { formula: true, error: "N_A" }],
      ],
    });
    const check = await runErrorGate(api, "sheet-id", ["'Roster'!A1:B2"]);
    expect(check.status).toBe("errors_found");
    expect(check.total_errors).toBe(2);
    expect(check.error_summary).toEqual({ REF: 1, N_A: 1 });
    expect(check.cells.map((c) => c.cell)).toEqual(["'Roster'!A2", "'Roster'!B2"]);
    expect(describeCheck(check)).toContain("REF");
  });

  test("LOADING is not an error, and a second read that settles it reports ok", async () => {
    const api = fakeApi(
      { Roster: [[{ formula: true, error: "LOADING" }]] },
      { Roster: [[{ formula: true }]] },
    );
    const check = await runErrorGate(api, "sheet-id", ["'Roster'!A1"], {
      sleep: noSleep,
      now: (() => {
        let t = 0;
        return () => (t += 100);
      })(),
    });
    expect(check.status).toBe("ok");
    expect(api.reads()).toBe(2);
  });

  test("LOADING that never settles is pending, never errors_found", async () => {
    const api = fakeApi({ Roster: [[{ formula: true, error: "LOADING" }]] });
    let clock = 0;
    const check = await runErrorGate(api, "sheet-id", ["'Roster'!A1"], {
      sleep: noSleep,
      now: () => (clock += 2000),
      loadingBudgetMs: 5000,
    });
    expect(check.status).toBe("pending");
    expect(check.total_errors).toBe(0);
    expect(check.note).toContain("still calculating");
  });

  test("caps the ranges it reads and says so", async () => {
    const api = fakeApi({ Roster: [[{}]] });
    const many = Array.from({ length: 30 }, (_, i) => `'Roster'!A${i + 1}`);
    const check = await runErrorGate(api, "sheet-id", many, { maxRanges: 5 });
    expect(check.ranges).toHaveLength(5);
    expect(api.ranges[0]).toHaveLength(5);
    expect(check.note).toContain("sheets_check");
  });

  test("deduplicates the ranges before reading", async () => {
    const api = fakeApi({ Roster: [[{}]] });
    await runErrorGate(api, "sheet-id", ["'Roster'!A1", "'Roster'!A1", "  "]);
    expect(api.ranges[0]).toEqual(["'Roster'!A1"]);
  });
});

// ---------------------------------------------------------------------------
// The two additions sheets_write and sheets_style need
// ---------------------------------------------------------------------------

describe("skipping on purpose", () => {
  test("a skip reason is carried through rather than dropped", async () => {
    let calls = 0;
    const api = {
      spreadsheets: {
        async get() {
          calls += 1;
          return { data: {} };
        },
      },
    };
    const check = await runErrorGate(api as never, "sheet-id", ["'Roster'!A1:C3"], {
      skip: "check was false, so this write did not read itself back.",
    });

    expect(check.status).toBe("skipped");
    expect(check.note).toContain("check was false");
    // A response that simply omits the check reads identically to one that
    // passed, which is the failure this avoids.
    expect(describeCheck(check)).toContain("check was false");
    expect(calls).toBe(0);
  });
});

describe("withinGateCap", () => {
  test("an open ended range is never worth reading back", () => {
    expect(withinGateCap({ startColumnIndex: 1, endColumnIndex: 2 })).toBe(false);
    expect(withinGateCap({ startRowIndex: 0, endRowIndex: 10 })).toBe(false);
  });

  test("an ordinary block is", () => {
    expect(
      withinGateCap({ startRowIndex: 0, endRowIndex: 80, startColumnIndex: 0, endColumnIndex: 6 }),
    ).toBe(true);
  });

  test("a whole large sheet is not", () => {
    expect(
      withinGateCap({ startRowIndex: 0, endRowIndex: 50_000, startColumnIndex: 0, endColumnIndex: 26 }),
    ).toBe(false);
  });

  test("the cap is adjustable", () => {
    const bounds = { startRowIndex: 0, endRowIndex: 10, startColumnIndex: 0, endColumnIndex: 10 };
    expect(withinGateCap(bounds, 99)).toBe(false);
    expect(withinGateCap(bounds, 100)).toBe(true);
  });
});
