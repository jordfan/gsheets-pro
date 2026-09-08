/**
 * Table helpers: typed columns, the metadata that carries the contract, and the
 * gate on status fills. All invented names.
 */
import { describe, expect, test } from "vitest";

import { METADATA_KEYS } from "../src/lib/contract.js";
import {
  buildColumnProperties,
  columnLetterOf,
  columnMetadataWrite,
  columnRangeOf,
  dataRangeOf,
  defaultStatusRole,
  describeTableRange,
  headerRangeOf,
  metadataRequest,
  requireBoundedRange,
  statusFillGate,
  statusFillSpecs,
  TABLE_COLUMN_TYPES,
} from "../src/lib/tables.js";

const RANGE = {
  sheetId: 0,
  startRowIndex: 0,
  endRowIndex: 12,
  startColumnIndex: 2,
  endColumnIndex: 7,
};

describe("column properties", () => {
  test("names and types come through, indexed within the Table", () => {
    const properties = buildColumnProperties([
      { name: "Instructor" },
      { name: "Fee", type: "CURRENCY" },
    ]);
    expect(properties).toEqual([
      { columnIndex: 0, columnName: "Instructor" },
      { columnIndex: 1, columnName: "Fee", columnType: "CURRENCY" },
    ]);
  });

  test("a dropdown carries its options as a ONE_OF_LIST rule", () => {
    const [status] = buildColumnProperties([
      { name: "Status", type: "DROPDOWN", options: ["Confirmed", "Pending"] },
    ]);
    expect(status.dataValidationRule?.condition).toEqual({
      type: "ONE_OF_LIST",
      values: [{ userEnteredValue: "Confirmed" }, { userEnteredValue: "Pending" }],
    });
  });

  test("a dropdown fed by a range gets a ONE_OF_RANGE rule", () => {
    const [status] = buildColumnProperties([
      { name: "Vendor", type: "DROPDOWN", options_range: "Lists!A2:A40" },
    ]);
    expect(status.dataValidationRule?.condition.values?.[0].userEnteredValue).toBe("=Lists!A2:A40");
  });

  test("the mistakes are caught with a hint", () => {
    expect(() => buildColumnProperties([{ name: "" }])).toThrowError(/has no name/);
    expect(() => buildColumnProperties([{ name: "Status", type: "DROPDOWN" }])).toThrowError(
      /has no options/,
    );
    expect(() => buildColumnProperties([{ name: "Fee", type: "CURRENCY", options: ["a"] }])).toThrowError(
      /has options but is typed CURRENCY/,
    );
    expect(() =>
      buildColumnProperties([{ name: "Fee", type: "MONEY" as never }]),
    ).toThrowError(/not a Table column type/);
  });

  test("the verified type list is the discovery document's, minus the unspecified member", () => {
    expect(TABLE_COLUMN_TYPES).toContain("PEOPLE_CHIP");
    expect(TABLE_COLUMN_TYPES).toContain("RATINGS_CHIP");
    expect(TABLE_COLUMN_TYPES as readonly string[]).not.toContain("COLUMN_TYPE_UNSPECIFIED");
  });
});

describe("ranges", () => {
  test("an open ended range is refused, because a Table needs its last row", () => {
    expect(() => requireBoundedRange({ sheetId: 0, startColumnIndex: 0 }, "A:F")).toThrowError(
      /needs a range with/,
    );
  });

  test("header, data and column ranges are carved out of the whole", () => {
    expect(headerRangeOf(RANGE)).toEqual({
      sheetId: 0,
      startRowIndex: 0,
      endRowIndex: 1,
      startColumnIndex: 2,
      endColumnIndex: 7,
    });
    expect(dataRangeOf(RANGE).startRowIndex).toBe(1);
    expect(columnRangeOf(RANGE, 1)).toEqual({
      sheetId: 0,
      startRowIndex: 1,
      endRowIndex: 12,
      startColumnIndex: 3,
      endColumnIndex: 4,
    });
  });

  test("a Table that does not start at column A still reports real letters", () => {
    expect(columnLetterOf(RANGE, 0)).toBe("C");
    expect(columnLetterOf(RANGE, 4)).toBe("G");
  });

  test("the summary counts data rows, not the header", () => {
    expect(describeTableRange("Instructors", RANGE, "C1:G12")).toBe(
      "Instructors covers C1:G12: 5 columns, 11 data rows.",
    );
  });
});

describe("contract metadata", () => {
  test("a new column entry is created at PROJECT visibility on the column dimension", () => {
    const request = metadataRequest(
      columnMetadataWrite({
        sheetId: 3,
        columnIndex: 4,
        column: { name: "Status", type: "DROPDOWN", role: "status", owner: "agent" },
        exists: false,
      }),
    ) as { createDeveloperMetadata: { developerMetadata: Record<string, unknown> } };

    const entry = request.createDeveloperMetadata.developerMetadata;
    expect(entry["metadataKey"]).toBe(METADATA_KEYS.column);
    expect(entry["visibility"]).toBe("PROJECT");
    expect(entry["location"]).toEqual({
      dimensionRange: { sheetId: 3, dimension: "COLUMNS", startIndex: 4, endIndex: 5 },
    });
    expect(JSON.parse(entry["metadataValue"] as string)).toEqual({
      header: "Status",
      role: "status",
      owner: "agent",
      type: "DROPDOWN",
    });
  });

  test("an existing entry is updated through a location lookup, not a metadata id", () => {
    const request = metadataRequest({
      key: METADATA_KEYS.sheet,
      value: { preset: "neutral" },
      location: { sheetId: 3 },
      exists: true,
    }) as { updateDeveloperMetadata: { dataFilters: Array<Record<string, never>>; fields: string } };

    const lookup = request.updateDeveloperMetadata.dataFilters[0]["developerMetadataLookup"] as Record<
      string,
      unknown
    >;
    expect(lookup["locationMatchingStrategy"]).toBe("EXACT_LOCATION");
    expect(lookup["metadataLocation"]).toEqual({ sheetId: 3 });
    expect(request.updateDeveloperMetadata.fields).toBe("metadataValue");
  });
});

describe("status fills", () => {
  test("common words read as the colour a person would pick", () => {
    expect(defaultStatusRole("Confirmed")).toBe("ok");
    expect(defaultStatusRole("Pending")).toBe("warn");
    expect(defaultStatusRole("Declined")).toBe("flag");
    expect(defaultStatusRole("Something else")).toBe("muted");
  });

  test("an override wins and a bad one is refused", () => {
    expect(statusFillSpecs(["Pending"], { Pending: "flag" })).toEqual([
      { option: "Pending", role: "flag" },
    ]);
    expect(() => statusFillSpecs(["Pending"], { Pending: "purple" })).toThrowError(
      /not a status role/,
    );
  });

  test("only a sheet the plugin created gets them", () => {
    expect(statusFillGate({ origin: "plugin" }).allowed).toBe(true);
    expect(statusFillGate({ creatingNow: true, existingRuleCount: 0 }).allowed).toBe(true);
  });

  test("an adopted sheet, a busy sheet, and a shared spreadsheet do not", () => {
    expect(statusFillGate({ origin: "adopted" })).toMatchObject({ allowed: false });
    expect(statusFillGate({ creatingNow: true, existingRuleCount: 2 })).toMatchObject({
      allowed: false,
    });
    expect(statusFillGate({ creatingNow: true, registryOwner: "shared" }).reason).toMatch(
      /shared owned/,
    );
    expect(statusFillGate({}).reason).toMatch(/no plugin metadata/);
  });
});
