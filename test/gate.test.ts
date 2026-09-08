/**
 * The error gate. A write that produced #REF! has to say so, and a formula that
 * is merely still calculating must not be reported as a failure.
 */
import { describe, expect, test } from "vitest";

import { checkRanges, describeCheck } from "../src/lib/gate.js";

function fakeSheets(pages: unknown[]) {
  let call = 0;
  return {
    calls: () => call,
    api: {
      spreadsheets: {
        async get() {
          const page = pages[Math.min(call, pages.length - 1)];
          call += 1;
          return { data: page };
        },
      },
    },
  };
}

function cell(formula?: string, errorType?: string, message?: string) {
  const out: Record<string, unknown> = {};
  if (formula) out["userEnteredValue"] = { formulaValue: formula };
  if (errorType) out["effectiveValue"] = { errorValue: { type: errorType, message } };
  return out;
}

function page(values: Array<Record<string, unknown>>) {
  return {
    sheets: [
      {
        properties: { title: "Budget" },
        data: [{ startRow: 1, startColumn: 1, rowData: [{ values }] }],
      },
    ],
  };
}

describe("checkRanges", () => {
  test("nothing to check says so rather than claiming clean", async () => {
    const { api } = fakeSheets([]);
    const result = await checkRanges(api, "x", []);
    expect(result.status).toBe("not_checked");
  });

  test("formulas with no errors come back clean, and are counted", async () => {
    const { api } = fakeSheets([page([cell("=B2*2"), cell("=B3*2")])]);
    const result = await checkRanges(api, "x", ["Budget!B2:C2"]);
    expect(result.status).toBe("clean");
    expect(result.total_formulas).toBe(2);
    expect(result.total_errors).toBe(0);
    expect(describeCheck(result)).toBe("Checked: 2 formulas, no errors.");
  });

  test("errors are counted by type and located", async () => {
    const { api } = fakeSheets([
      page([cell("=B2*2", "REF", "Reference does not exist"), cell("=1/0", "DIVIDE_BY_ZERO")]),
    ]);
    const result = await checkRanges(api, "x", ["Budget!B2:C2"]);
    expect(result.status).toBe("errors_found");
    expect(result.total_errors).toBe(2);
    expect(result.error_summary).toEqual({ REF: 1, DIVIDE_BY_ZERO: 1 });
    expect(result.examples[0]).toEqual({
      cell: "Budget!B2",
      type: "REF",
      message: "Reference does not exist",
    });
    expect(describeCheck(result)).toMatch(/2 errors \(1 REF, 1 DIVIDE_BY_ZERO\), starting at Budget!B2/);
  });

  test("a formula still calculating is pending, not an error", async () => {
    const slept: number[] = [];
    const { api, calls } = fakeSheets([page([cell("=IMPORTRANGE(...)", "LOADING")])]);
    const result = await checkRanges(api, "x", ["Budget!B2"], {
      maxWaitMs: 600,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(result.status).toBe("pending");
    expect(result.total_errors).toBe(0);
    expect(calls()).toBeGreaterThan(1);
    expect(slept.length).toBeGreaterThan(0);
  });

  test("a LOADING cell that settles on the retry reports clean", async () => {
    const { api } = fakeSheets([
      page([cell("=IMPORTRANGE(...)", "LOADING")]),
      page([cell("=IMPORTRANGE(...)")]),
    ]);
    const result = await checkRanges(api, "x", ["Budget!B2"], {
      maxWaitMs: 2000,
      sleep: async () => {},
    });
    expect(result.status).toBe("clean");
  });
});
