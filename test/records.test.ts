import { describe, expect, test } from "vitest";

import { GsheetsError } from "../src/lib/errors.js";

import {
  applyWhere,
  findInGrid,
  matchesClause,
  normalizeHeaders,
  paginate,
  toRecords,
  type CellValue,
  type SheetRecord,
} from "../src/lib/records.js";

const HEADERS = ["Name", "Grade", "Fee", "Status"];
const ROWS: CellValue[][] = [
  ["Ana", 3, 120, "Enrolled"],
  ["Bo", 4, 160, "Waitlist"],
  ["Cy", 5, 120, ""],
];

const records = toRecords(ROWS, HEADERS, { firstDataRow: 2 });

describe("normalizeHeaders", () => {
  test("trims and keeps the text", () => {
    expect(normalizeHeaders([" Name ", "Grade"])).toEqual(["Name", "Grade"]);
  });

  test("a blank header becomes its column letter, so the column is not lost", () => {
    expect(normalizeHeaders(["Name", "", "Fee"])).toEqual(["Name", "B", "Fee"]);
    expect(normalizeHeaders([null, undefined])).toEqual(["A", "B"]);
  });

  test("duplicates are suffixed rather than colliding", () => {
    expect(normalizeHeaders(["Notes", "Notes", "Notes"])).toEqual([
      "Notes",
      "Notes (2)",
      "Notes (3)",
    ]);
  });

  test("duplicate detection ignores case", () => {
    expect(normalizeHeaders(["Notes", "notes"])).toEqual(["Notes", "notes (2)"]);
  });

  test("a width wider than the headers pads with letters", () => {
    expect(normalizeHeaders(["Name"], 3)).toEqual(["Name", "B", "C"]);
  });
});

describe("toRecords", () => {
  test("keys each row by header and stamps the true sheet row", () => {
    expect(records[0]).toEqual({ _row: 2, Name: "Ana", Grade: 3, Fee: 120, Status: "Enrolled" });
    expect(records.map((r) => r._row)).toEqual([2, 3, 4]);
  });

  test("a short row is padded with empty strings, not undefined", () => {
    const [record] = toRecords([["Ana"]], HEADERS, { firstDataRow: 2 });
    expect(record).toEqual({ _row: 2, Name: "Ana", Grade: "", Fee: "", Status: "" });
  });

  test("blank rows are skipped but do not renumber the rest", () => {
    const withGap = toRecords([["Ana"], [], ["Bo"]], HEADERS, { firstDataRow: 2 });
    expect(withGap.map((r) => r._row)).toEqual([2, 4]);
  });

  test("blank rows can be kept", () => {
    const kept = toRecords([["Ana"], []], HEADERS, { firstDataRow: 2, skipBlank: false });
    expect(kept).toHaveLength(2);
  });
});

describe("where", () => {
  const clause = (column: string, op: string, value?: unknown) =>
    ({ column, op, value }) as never;

  test("eq ignores case", () => {
    expect(applyWhere(records, [clause("Status", "eq", "enrolled")], HEADERS)).toHaveLength(1);
  });

  test("contains, starts_with and ends_with", () => {
    expect(matchesClause(records[0], clause("Name", "contains", "n"), HEADERS)).toBe(true);
    expect(matchesClause(records[0], clause("Name", "starts_with", "A"), HEADERS)).toBe(true);
    expect(matchesClause(records[0], clause("Name", "ends_with", "a"), HEADERS)).toBe(true);
    expect(matchesClause(records[0], clause("Name", "not_contains", "z"), HEADERS)).toBe(true);
  });

  test("blank and not_blank", () => {
    expect(applyWhere(records, [clause("Status", "blank")], HEADERS).map((r) => r._row)).toEqual([4]);
    expect(applyWhere(records, [clause("Status", "not_blank")], HEADERS)).toHaveLength(2);
  });

  test("numeric comparisons work on numbers and on formatted currency", () => {
    expect(applyWhere(records, [clause("Fee", "gt", 130)], HEADERS).map((r) => r._row)).toEqual([3]);
    const formatted = toRecords([["Ana", "3", "$1,200"]], ["Name", "Grade", "Fee"], {
      firstDataRow: 2,
    });
    expect(matchesClause(formatted[0], clause("Fee", "gte", 1200), ["Name", "Grade", "Fee"])).toBe(
      true,
    );
  });

  test("in takes a list", () => {
    expect(
      applyWhere(records, [clause("Name", "in", ["ana", "cy"])], HEADERS).map((r) => r._row),
    ).toEqual([2, 4]);
  });

  test("clauses combine with and", () => {
    const filtered = applyWhere(
      records,
      [clause("Fee", "eq", 120), clause("Status", "not_blank")],
      HEADERS,
    );
    expect(filtered.map((r) => r._row)).toEqual([2]);
  });

  test("no clauses returns everything, and the same array contents", () => {
    expect(applyWhere(records, undefined, HEADERS)).toHaveLength(3);
    expect(applyWhere(records, [], HEADERS)).toHaveLength(3);
  });

  test("a column letter works when a header does not", () => {
    expect(matchesClause(records[0], clause("A", "eq", "Ana"), HEADERS)).toBe(true);
  });

  test("a column that does not exist names the ones that do, in the hint", () => {
    expect(() => matchesClause(records[0], clause("Nope", "eq", "x"), HEADERS)).toThrow(
      /No column named "Nope"/,
    );
    try {
      matchesClause(records[0], clause("Nope", "eq", "x"), HEADERS);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GsheetsError);
      expect((error as GsheetsError).hint).toMatch(/Name, Grade, Fee, Status/);
    }
  });

  test("a tab with no headers says to filter by column letter", () => {
    const bare = toRecords([["Ana"]], ["A"], { firstDataRow: 1 });
    expect(() => matchesClause(bare[0], clause("Nope", "eq", "x"), [])).toThrow(
      /No column named "Nope"/,
    );
  });

  test("filtering never renumbers _row", () => {
    const filtered = applyWhere(records, [clause("Fee", "eq", 120)], HEADERS);
    expect(filtered.map((r) => r._row)).toEqual([2, 4]);
  });
});

describe("findInGrid", () => {
  const grid: CellValue[][] = [
    ["Name", "Notes"],
    ["Ana", "needs a form"],
    ["Bo", "Form sent"],
  ];

  test("finds every cell containing the text, ignoring case by default", () => {
    const hits = findInGrid("Tracker", grid, { query: "form" });
    expect(hits.map((h) => h.cell)).toEqual(["B2", "B3"]);
    expect(hits[0].sheet).toBe("Tracker");
    expect(hits[0].row).toBe(2);
    expect(hits[0].column).toBe("B");
  });

  test("match_case narrows it", () => {
    expect(findInGrid("Tracker", grid, { query: "Form", matchCase: true })).toHaveLength(1);
  });

  test("whole_cell narrows it further", () => {
    expect(findInGrid("Tracker", grid, { query: "Form sent", wholeCell: true })).toHaveLength(1);
    expect(findInGrid("Tracker", grid, { query: "Form", wholeCell: true })).toHaveLength(0);
  });

  test("regex works and a bad pattern is a clear error", () => {
    expect(findInGrid("Tracker", grid, { query: "^A", regex: true })).toHaveLength(1);
    expect(() => findInGrid("Tracker", grid, { query: "(unclosed", regex: true })).toThrow(
      /not a valid regular expression/,
    );
  });

  test("the header above a hit is reported", () => {
    const hits = findInGrid("Tracker", grid, { query: "Ana" }, ["Name", "Notes"]);
    expect(hits[0].header).toBe("Name");
  });

  test("the limit is honoured", () => {
    expect(findInGrid("Tracker", grid, { query: "o", limit: 1 })).toHaveLength(1);
  });

  test("empty cells never match", () => {
    expect(findInGrid("Tracker", [["", null]], { query: "" })).toEqual([]);
  });
});

describe("paginate", () => {
  const items = Array.from({ length: 10 }, (_, i) => i);

  test("returns a slice and the next offset", () => {
    const page = paginate(items, 0, 4);
    expect(page.items).toEqual([0, 1, 2, 3]);
    expect(page.total).toBe(10);
    expect(page.nextOffset).toBe(4);
  });

  test("the last page has no next offset", () => {
    expect(paginate(items, 8, 4).nextOffset).toBeUndefined();
  });

  test("an offset past the end is empty rather than an error", () => {
    const page = paginate(items, 50, 4);
    expect(page.items).toEqual([]);
    expect(page.nextOffset).toBeUndefined();
  });

  test("offsets and limits are coerced into sanity", () => {
    expect(paginate(items, -5, 0).offset).toBe(0);
    expect(paginate(items, -5, 0).limit).toBe(1);
  });

  test("paging through covers every item exactly once", () => {
    const seen: number[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page: ReturnType<typeof paginate<number>> = paginate(items, offset, 3);
      seen.push(...page.items);
      offset = page.nextOffset;
    }
    expect(seen).toEqual(items);
  });
});

describe("_row survives the whole pipeline", () => {
  test("read, filter, page: the row number is still the sheet's", () => {
    const many: CellValue[][] = Array.from({ length: 20 }, (_, i) => [
      `Person ${i}`,
      i % 2 === 0 ? "Enrolled" : "Waitlist",
    ]);
    const all: SheetRecord[] = toRecords(many, ["Name", "Status"], { firstDataRow: 2 });
    const enrolled = applyWhere(all, [{ column: "Status", op: "eq", value: "Enrolled" }], [
      "Name",
      "Status",
    ]);
    const page = paginate(enrolled, 2, 3);
    expect(page.items.map((r) => r._row)).toEqual([6, 8, 10]);
  });
});
