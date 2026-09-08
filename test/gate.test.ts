/**
 * The error gate, and the one thing it must get right about LOADING.
 *
 * A cell whose IMPORTRANGE has not come back yet is not a broken sheet. If the
 * gate reported it as an error, the model would learn to panic over a sheet
 * that is fine a second later; if it reported success, it would be lying. So
 * it waits, briefly, and then says pending.
 */
import { describe, expect, test } from "vitest";

import {
  describeCheck,
  runGate,
  summarizeGrid,
  withinGateCap,
  type CheckResult,
} from "../src/lib/gate.js";

function gridSheet(
  title: string,
  cells: Array<Array<{ formula?: string; error?: string }>>,
  startRow = 0,
  startColumn = 0,
) {
  return {
    properties: { title },
    data: [
      {
        startRow,
        startColumn,
        rowData: cells.map((row) => ({
          values: row.map((cell) => ({
            ...(cell.formula ? { userEnteredValue: { formulaValue: cell.formula } } : {}),
            ...(cell.error ? { effectiveValue: { errorValue: { type: cell.error } } } : {}),
          })),
        })),
      },
    ],
  };
}

/** A client that hands back a scripted sequence of responses. */
function fakeApi(responses: unknown[]) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    api: {
      spreadsheets: {
        async get() {
          const response = responses[Math.min(calls, responses.length - 1)];
          calls += 1;
          return { data: response };
        },
      },
    },
  };
}

describe("summarizeGrid", () => {
  test("counts formulas and locates every error by A1", () => {
    const { totalFormulas, errors } = summarizeGrid([
      gridSheet("Roster", [
        [{ formula: "=D2*55" }, {}],
        [{ formula: "=D3*55", error: "REF" }, { error: "N_A" }],
      ]),
    ]);
    expect(totalFormulas).toBe(2);
    expect(errors.get("REF")).toEqual(["Roster!A2"]);
    expect(errors.get("N_A")).toEqual(["Roster!B2"]);
  });

  test("respects the block's own origin, so A1 is the real cell", () => {
    const { errors } = summarizeGrid([
      gridSheet("Roster", [[{ error: "VALUE" }]], 9, 3),
    ]);
    expect(errors.get("VALUE")).toEqual(["Roster!D10"]);
  });

  test("an empty grid is not an error", () => {
    const { totalFormulas, errors } = summarizeGrid([]);
    expect(totalFormulas).toBe(0);
    expect(errors.size).toBe(0);
  });
});

describe("runGate", () => {
  const ranges = ["'Roster'!A1:C3"];

  test("a clean range comes back success", async () => {
    const { api } = fakeApi([{ sheets: [gridSheet("Roster", [[{ formula: "=1+1" }]])] }]);
    const check = await runGate(api as never, "sheet-id", ranges);
    expect(check.status).toBe("success");
    expect(check.total_formulas).toBe(1);
    expect(check.total_errors).toBe(0);
  });

  test("errors are keyed on the API's own type names", async () => {
    const { api } = fakeApi([
      { sheets: [gridSheet("Roster", [[{ formula: "=A1/0", error: "DIVIDE_BY_ZERO" }]])] },
    ]);
    const check = await runGate(api as never, "sheet-id", ranges);
    expect(check.status).toBe("errors_found");
    expect(check.total_errors).toBe(1);
    expect(check.error_summary.DIVIDE_BY_ZERO).toEqual({
      count: 1,
      locations: ["Roster!A1"],
      truncated: 0,
    });
  });

  test("LOADING is retried, and a cell that finishes is not an error", async () => {
    const slept: number[] = [];
    const fake = fakeApi([
      { sheets: [gridSheet("Roster", [[{ formula: "=IMPORTRANGE()", error: "LOADING" }]])] },
      { sheets: [gridSheet("Roster", [[{ formula: "=IMPORTRANGE()" }]])] },
    ]);
    const check = await runGate(fake.api as never, "sheet-id", ranges, {
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(check.status).toBe("success");
    expect(slept.length).toBeGreaterThan(0);
    expect(fake.calls).toBe(2);
  });

  test("LOADING that never finishes is pending, not errors_found", async () => {
    const slept: number[] = [];
    const { api } = fakeApi([
      { sheets: [gridSheet("Roster", [[{ formula: "=IMPORTRANGE()", error: "LOADING" }]])] },
    ]);
    const check = await runGate(api as never, "sheet-id", ranges, {
      sleep: async (ms) => {
        slept.push(ms);
      },
      loadingBudgetMs: 2000,
    });
    expect(check.status).toBe("pending");
    expect(check.total_errors).toBe(0);
    expect(slept.reduce((a, b) => a + b, 0)).toBe(2000);
  });

  test("a real error alongside a LOADING cell still stops the work", async () => {
    const { api } = fakeApi([
      {
        sheets: [
          gridSheet("Roster", [
            [{ error: "LOADING" }, { error: "REF" }],
          ]),
        ],
      },
    ]);
    const check = await runGate(api as never, "sheet-id", ranges, {
      sleep: async () => {},
      loadingBudgetMs: 100,
    });
    expect(check.status).toBe("errors_found");
  });

  test("no ranges means nothing to read back, and it says so", async () => {
    const fake = fakeApi([{}]);
    const check = await runGate(fake.api as never, "sheet-id", []);
    expect(check.status).toBe("success");
    expect(check.skipped).toMatch(/nothing to read back/i);
    expect(fake.calls).toBe(0);
  });

  test("an explicit skip does not call the API at all", async () => {
    const fake = fakeApi([{}]);
    const check = await runGate(fake.api as never, "sheet-id", ranges, { skip: "check was false." });
    expect(check.skipped).toBe("check was false.");
    expect(fake.calls).toBe(0);
  });

  test("locations are capped and the rest are counted", async () => {
    const row = Array.from({ length: 40 }, () => ({ error: "REF" }));
    const { api } = fakeApi([{ sheets: [gridSheet("Roster", [row])] }]);
    const check = await runGate(api as never, "sheet-id", ranges);
    expect(check.error_summary.REF.count).toBe(40);
    expect(check.error_summary.REF.locations).toHaveLength(20);
    expect(check.error_summary.REF.truncated).toBe(20);
  });
});

describe("the cap and the prose", () => {
  test("an unbounded range is never read back", () => {
    expect(withinGateCap({ startRowIndex: 0 })).toBe(false);
    expect(withinGateCap({ startRowIndex: 0, endRowIndex: 10, startColumnIndex: 0, endColumnIndex: 5 })).toBe(
      true,
    );
    expect(
      withinGateCap({ startRowIndex: 0, endRowIndex: 100000, startColumnIndex: 0, endColumnIndex: 26 }),
    ).toBe(false);
  });

  test("errors_found reads as a stop", () => {
    const check: CheckResult = {
      status: "errors_found",
      total_formulas: 3,
      total_errors: 2,
      error_summary: { REF: { count: 2, locations: ["Roster!A2", "Roster!A3"], truncated: 0 } },
    };
    expect(describeCheck(check)).toContain("before calling the work done");
    expect(describeCheck(check)).toContain("Roster!A2");
  });

  test("a skipped gate says it was skipped rather than clean", () => {
    const check: CheckResult = {
      status: "success",
      total_formulas: 0,
      total_errors: 0,
      error_summary: {},
      skipped: "check was false.",
    };
    expect(describeCheck(check)).toContain("No error check was run");
  });
});
