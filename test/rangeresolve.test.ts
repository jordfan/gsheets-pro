/**
 * Resolving tab names and A1 inside raw batchUpdate requests.
 *
 * All ids and names here are invented.
 */
import { describe, expect, test } from "vitest";

import { describeRequestType, resolveRequests } from "../src/lib/rangeresolve.js";

const SHEETS = new Map([
  ["roster", { sheetId: 0, title: "Roster" }],
  ["fees", { sheetId: 42, title: "Fees" }],
]);

const resolver = {
  resolveSheet: async (name: string) => {
    const hit = SHEETS.get(name.trim().toLowerCase());
    if (!hit) throw new Error(`no tab ${name}`);
    return hit;
  },
  resolveSheetId: async (sheetId: number) => [...SHEETS.values()].find((s) => s.sheetId === sheetId),
};

describe("resolveRequests", () => {
  test("turns a tab name into a sheet id", async () => {
    const result = await resolveRequests([{ deleteSheet: { sheetId: "Fees" } }], resolver);
    expect(result.requests[0]).toEqual({ deleteSheet: { sheetId: 42 } });
    expect(result.sheets).toEqual(["Fees"]);
  });

  test("turns A1 into a GridRange where a GridRange belongs", async () => {
    const result = await resolveRequests(
      [{ sortRange: { range: "'Roster'!A2:F80", sortSpecs: [{ dimensionIndex: 0 }] } }],
      resolver,
    );
    expect(result.requests[0]).toEqual({
      sortRange: {
        range: { sheetId: 0, startRowIndex: 1, endRowIndex: 80, startColumnIndex: 0, endColumnIndex: 6 },
        sortSpecs: [{ dimensionIndex: 0 }],
      },
    });
    expect(result.touched).toEqual(["'Roster'!A2:F80"]);
  });

  test("turns a row span into a DimensionRange where one belongs", async () => {
    const result = await resolveRequests([{ insertDimension: { range: "'Roster'!5:9" } }], resolver);
    expect(result.requests[0]).toEqual({
      insertDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 4, endIndex: 9 } },
    });
    expect(result.touched).toEqual(["'Roster'!5:9"]);
  });

  test("reads a column span on a dimension field", async () => {
    const result = await resolveRequests([{ deleteDimension: { range: "'Roster'!B:D" } }], resolver);
    expect(result.requests[0]).toEqual({
      deleteDimension: { range: { sheetId: 0, dimension: "COLUMNS", startIndex: 1, endIndex: 4 } },
    });
  });

  test("a cell block on a dimension field is a teaching error, not a 400 from Google", async () => {
    await expect(
      resolveRequests([{ insertDimension: { range: "'Roster'!A2:F80" } }], resolver),
    ).rejects.toMatchObject({ code: "bad_range" });
  });

  test("moveDimension.source is a DimensionRange and destinationIndex is left alone", async () => {
    const result = await resolveRequests(
      [{ moveDimension: { source: "'Roster'!2:4", destinationIndex: 10 } }],
      resolver,
    );
    expect(result.requests[0]).toEqual({
      moveDimension: {
        source: { sheetId: 0, dimension: "ROWS", startIndex: 1, endIndex: 4 },
        destinationIndex: 10,
      },
    });
  });

  test("an unqualified range uses the default sheet", async () => {
    const result = await resolveRequests([{ trimWhitespace: { range: "A1:C10" } }], {
      ...resolver,
      defaultSheet: "Fees",
    });
    expect(result.requests[0]).toMatchObject({ trimWhitespace: { range: { sheetId: 42 } } });
  });

  test("an unqualified range with no default sheet says which argument is missing", async () => {
    await expect(
      resolveRequests([{ trimWhitespace: { range: "A1:C10" } }], resolver),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  test("an array of ranges is converted element by element", async () => {
    const result = await resolveRequests(
      [{ addConditionalFormatRule: { rule: { ranges: ["'Roster'!A2:A80", "'Fees'!B2:B9"] } } }],
      resolver,
    );
    const ranges = (
      result.requests[0] as { addConditionalFormatRule: { rule: { ranges: unknown[] } } }
    ).addConditionalFormatRule.rule.ranges;
    expect(ranges).toEqual([
      { sheetId: 0, startRowIndex: 1, endRowIndex: 80, startColumnIndex: 0, endColumnIndex: 1 },
      { sheetId: 42, startRowIndex: 1, endRowIndex: 9, startColumnIndex: 1, endColumnIndex: 2 },
    ]);
    expect(result.sheets).toEqual(["Roster", "Fees"]);
  });

  test("a longhand GridRange passes through and is still counted as touched", async () => {
    const result = await resolveRequests(
      [
        {
          repeatCell: {
            range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 3 },
            fields: "userEnteredFormat",
          },
        },
      ],
      resolver,
    );
    expect(result.requests[0]).toMatchObject({ repeatCell: { fields: "userEnteredFormat" } });
    expect(result.touched).toEqual(["'Roster'!A1:C1"]);
  });

  test("a whole tab named by id is reported by name", async () => {
    const result = await resolveRequests([{ deleteSheet: { sheetId: 42 } }], resolver);
    expect(result.plan[0].targets).toEqual(["'Fees'"]);
  });

  test("a request naming no range at all is reported as unlocatable", async () => {
    const result = await resolveRequests([{ addSheet: { properties: { title: "New" } } }], resolver);
    expect(result.unlocatable).toEqual(["addSheet"]);
    expect(result.touched).toEqual([]);
  });

  test("an entry with two keys is refused with a reason", async () => {
    await expect(
      resolveRequests([{ addSheet: {}, deleteSheet: { sheetId: "Fees" } }], resolver),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  test("an entry that is not an object is refused", async () => {
    await expect(resolveRequests(["addSheet"], resolver)).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });

  test("the plan says what each request does in words", async () => {
    const result = await resolveRequests(
      [{ addChart: { chart: { spec: {} } } }, { sortRange: { range: "'Roster'!A2:F80" } }],
      resolver,
    );
    expect(result.plan[0].summary).toBe("add a chart");
    expect(result.plan[1].targets).toEqual(["'Roster'!A2:F80"]);
  });

  test("a request type nobody has named yet describes itself", () => {
    expect(describeRequestType("someBrandNewRequest")).toBe("someBrandNewRequest");
  });
});
