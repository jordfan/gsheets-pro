import { describe, expect, test } from "vitest";

import { GsheetsError } from "../src/lib/errors.js";
import {
  count,
  DEFAULT_RESULT_BUDGET_CHARS,
  errorOf,
  failure,
  guarded,
  isFailure,
  lines,
  listOf,
  MAX_RESULT_SIZE_KEY,
  ok,
  truncateRows,
} from "../src/lib/result.js";

describe("ok", () => {
  test("carries prose and structure together", () => {
    const response = ok("Read 3 rows.", { rows: 3 });
    expect(response.content[0]).toEqual({ type: "text", text: "Read 3 rows." });
    expect(response.structuredContent).toEqual({ rows: 3 });
    expect(response.isError).toBeUndefined();
  });

  test("declares a result budget only when asked", () => {
    expect(ok("hi")._meta).toBeUndefined();
    expect(ok("hi", {}, { maxResultSizeChars: 120_000 })._meta).toEqual({
      [MAX_RESULT_SIZE_KEY]: 120_000,
    });
  });

  test("extra meta is merged", () => {
    const response = ok("hi", {}, { maxResultSizeChars: 10, meta: { trace: "abc" } });
    expect(response._meta).toEqual({ [MAX_RESULT_SIZE_KEY]: 10, trace: "abc" });
  });

  test("the budget key is the one Claude Code reads", () => {
    expect(MAX_RESULT_SIZE_KEY).toBe("anthropic/maxResultSizeChars");
    expect(DEFAULT_RESULT_BUDGET_CHARS).toBeGreaterThan(0);
  });
});

describe("failure", () => {
  test("is flagged, structured, and readable", () => {
    const response = failure(new GsheetsError("bad_range", "Nope.", "Try A1:C10."));
    expect(isFailure(response)).toBe(true);
    expect(response.content[0].text).toContain("Try A1:C10.");
    expect(errorOf(response)).toEqual({ code: "bad_range", message: "Nope.", hint: "Try A1:C10." });
  });

  test("an unexpected throw still gets a code", () => {
    expect(errorOf(failure(new Error("boom")))?.code).toBe("internal");
  });
});

describe("guarded", () => {
  test("passes a success through untouched", async () => {
    const handler = guarded(async () => ok("fine"));
    expect(await handler({})).toEqual(ok("fine"));
  });

  test("turns a throw into a structured error rather than a protocol error", async () => {
    const handler = guarded(async () => {
      throw new GsheetsError("sheet_not_found", "No tab named Trackr.", "The tabs are: Tracker.");
    });
    const response = await handler({});
    expect(isFailure(response)).toBe(true);
    expect(errorOf(response)?.code).toBe("sheet_not_found");
  });

  test("an API shaped rejection gets the matching hint", async () => {
    const handler = guarded(async () => {
      throw Object.assign(new Error("not found"), { response: { status: 404 } });
    });
    expect(errorOf(await handler({}))?.hint).toMatch(/long id/);
  });
});

describe("prose helpers", () => {
  test("lines drops the empty parts", () => {
    expect(lines("a", undefined, "", false, "b")).toBe("a\nb");
  });

  test("count pluralizes", () => {
    expect(count(1, "row")).toBe("1 row");
    expect(count(0, "row")).toBe("0 rows");
    expect(count(2, "entry", "entries")).toBe("2 entries");
  });

  test("listOf reads like a person wrote it", () => {
    expect(listOf([])).toBe("");
    expect(listOf(["A"])).toBe("A");
    expect(listOf(["A", "B"])).toBe("A and B");
    expect(listOf(["A", "B", "C"])).toBe("A, B and C");
    expect(listOf(["A", "B"], "or")).toBe("A or B");
  });

  test("truncateRows stops at the budget and says how many it dropped", () => {
    const rows = ["aaaa", "bbbb", "cccc"];
    const result = truncateRows(rows, 10, (r) => r);
    expect(result.shown).toBe(2);
    expect(result.dropped).toBe(1);
    expect(result.text).toBe("aaaa\nbbbb");
  });

  test("a generous budget drops nothing", () => {
    expect(truncateRows(["a", "b"], 1000, (r) => r).dropped).toBe(0);
  });
});
