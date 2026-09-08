/**
 * `sheets_settings`: the block, and named ranges on their own.
 * All ids and names are invented.
 */
import { describe, expect, test } from "vitest";

import { errorOf, isFailure } from "../src/lib/result.js";
import { createSettingsTool, dateSerial } from "../src/tools/settings.js";
import {
  FAKE_ID,
  makeMutableContext,
  requestsOfKind,
  type FakeWorkbook,
} from "./helpers/fakeMutableContext.js";

const WORKBOOK: FakeWorkbook = {
  title: "Program model",
  tabs: [
    { title: "Assumptions", sheetId: 0, cells: [[]] },
    { title: "Workings", sheetId: 1, cells: [[]] },
  ],
};

const ITEMS = [
  { label: "Fee per session", value: 55, unit: "dollars", source: "2026-27 vendor agreement", format: "currency" as const },
  { label: "Sessions per term", value: 8, unit: "sessions" },
  { label: "Term total", value: "=Fee_per_session*Sessions_per_term", format: "currency" as const },
];

function tool(workbook: FakeWorkbook = WORKBOOK, registryJson?: string) {
  const { context, calls, requests } = makeMutableContext(workbook, registryJson);
  return { settings: createSettingsTool({ getContext: async () => context }), calls, requests };
}

describe("the settings block", () => {
  test("writes the four columns, names every value cell, and reports the layout", async () => {
    const { settings, requests } = tool();
    const result = await settings.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Assumptions",
      title: "Assumptions",
      items: ITEMS,
    });
    expect(isFailure(result)).toBe(false);

    const structured = result.structuredContent as Record<string, never>;
    expect(structured["block"]).toBe("A2:D5");
    expect(structured["value_column"]).toBe("B3:B5");

    const names = requestsOfKind<{ namedRange: { name: string } }>(requests(), "addNamedRange");
    expect(names.map((n) => n.namedRange.name)).toEqual([
      "Fee_per_session",
      "Sessions_per_term",
      "Term_total",
    ]);
  });

  test("a formula value goes in as a formula, not as text", async () => {
    const { settings, requests } = tool();
    await settings.handler({ spreadsheet_id: FAKE_ID, sheet: "Assumptions", items: ITEMS });
    const cells = requestsOfKind<{ rows: Array<{ values: Array<Record<string, never>> }> }>(
      requests(),
      "updateCells",
    );
    const dataRows = cells[cells.length - 1].rows;
    expect(dataRows[2].values[1]["userEnteredValue"]).toEqual({
      formulaValue: "=Fee_per_session*Sessions_per_term",
    });
    expect(dataRows[0].values[1]["userEnteredValue"]).toEqual({ numberValue: 55 });
  });

  test("the value column carries the input colour and a number format", async () => {
    const { settings, requests } = tool();
    await settings.handler({ spreadsheet_id: FAKE_ID, sheet: "Assumptions", items: ITEMS });
    const cells = requestsOfKind<{ rows: Array<{ values: Array<Record<string, never>> }> }>(
      requests(),
      "updateCells",
    );
    const valueCell = cells[cells.length - 1].rows[0].values[1] as Record<string, never>;
    const format = valueCell["userEnteredFormat"] as Record<string, never>;
    expect(format["textFormat"]["foregroundColorStyle"]).toBeDefined();
    expect(format["numberFormat"]).toMatchObject({ type: "CURRENCY" });
    expect(format["horizontalAlignment"]).toBe("RIGHT");
  });

  test("protects the block warning only, colours the tab, and records the sheet", async () => {
    const { settings, requests } = tool();
    await settings.handler({ spreadsheet_id: FAKE_ID, sheet: "Assumptions", items: ITEMS });
    const all = requests();
    const [protection] = requestsOfKind<{ protectedRange: Record<string, never> }>(
      all,
      "addProtectedRange",
    );
    expect(protection.protectedRange["warningOnly"]).toBe(true);
    expect(requestsOfKind<{ fields: string }>(all, "updateSheetProperties")[0].fields).toBe(
      "tabColorStyle",
    );
    const created = requestsOfKind<{ developerMetadata: Record<string, string> }>(
      all,
      "createDeveloperMetadata",
    );
    expect(created[0].developerMetadata["metadataKey"]).toBe("gsheets.sheet");
  });

  test("running it again repoints the existing names instead of duplicating them", async () => {
    const already: FakeWorkbook = {
      ...WORKBOOK,
      namedRanges: [
        {
          namedRangeId: "nr1",
          name: "Fee_per_session",
          range: { sheetId: 0, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 1, endColumnIndex: 2 },
        },
      ],
    };
    const { settings, requests } = tool(already);
    await settings.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Assumptions",
      title: "Assumptions",
      items: ITEMS,
    });
    const all = requests();
    expect(requestsOfKind<{ namedRange: { name: string } }>(all, "addNamedRange").map((n) => n.namedRange.name)).toEqual([
      "Sessions_per_term",
      "Term_total",
    ]);
    expect(requestsOfKind<{ namedRange: { namedRangeId: string } }>(all, "updateNamedRange")[0].namedRange.namedRangeId).toBe(
      "nr1",
    );
  });

  test("a name used elsewhere in the workbook is avoided rather than clashing", async () => {
    const elsewhere: FakeWorkbook = {
      ...WORKBOOK,
      namedRanges: [
        {
          namedRangeId: "nr9",
          name: "Fee_per_session",
          range: { sheetId: 1, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
        },
      ],
    };
    const { settings, requests } = tool(elsewhere);
    await settings.handler({ spreadsheet_id: FAKE_ID, sheet: "Assumptions", items: ITEMS });
    const names = requestsOfKind<{ namedRange: { name: string } }>(requests(), "addNamedRange");
    expect(names[0].namedRange.name).toBe("Fee_per_session_2");
  });

  test("the registry can put the block's columns out of bounds", async () => {
    const registry = JSON.stringify({
      spreadsheets: { [FAKE_ID]: { name: "Program model", owner: "shared", writable_columns: ["F:H"] } },
    });
    const { settings, calls } = tool(WORKBOOK, registry);
    const result = await settings.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Assumptions",
      items: ITEMS,
    });
    expect(errorOf(result)?.code).toBe("contract_violation");
    expect(calls.batchUpdate).toHaveLength(0);
  });

  test("the block is read back afterwards, because it can hold formulas", async () => {
    const { settings, calls } = tool();
    const result = await settings.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Assumptions",
      items: ITEMS,
    });
    const check = (result.structuredContent as Record<string, never>)["check"] as { status: string };
    expect(check.status).toBeTruthy();
    const gateRead = calls.get[calls.get.length - 1];
    expect(gateRead["ranges"]).toEqual(["'Assumptions'!B2:B4"]);
  });

  test("no items is a refusal with an example", async () => {
    const { settings } = tool();
    const result = await settings.handler({ spreadsheet_id: FAKE_ID, sheet: "Assumptions", items: [] });
    expect(errorOf(result)?.code).toBe("invalid_argument");
    expect(result.content[0].text).toMatch(/Fee per session/);
  });
});

describe("named ranges on their own", () => {
  const withNames: FakeWorkbook = {
    ...WORKBOOK,
    namedRanges: [
      {
        namedRangeId: "nr1",
        name: "Fee_per_session",
        range: { sheetId: 0, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 1, endColumnIndex: 2 },
      },
    ],
  };

  test("list says where each one points", async () => {
    const { settings } = tool(withNames);
    const result = await settings.handler({ spreadsheet_id: FAKE_ID, action: "list_named_ranges" });
    expect(result.content[0].text).toMatch(/Fee_per_session -> 'Assumptions'!B4/);
  });

  test("add creates one, sanitising the name", async () => {
    const { settings, requests } = tool();
    const result = await settings.handler({
      spreadsheet_id: FAKE_ID,
      action: "add_named_range",
      sheet: "Assumptions",
      name: "Fee per session",
      range: "B4",
    });
    expect(isFailure(result)).toBe(false);
    expect(requestsOfKind<{ namedRange: { name: string } }>(requests(), "addNamedRange")[0].namedRange.name).toBe(
      "Fee_per_session",
    );
    expect(result.content[0].text).toMatch(/became Fee_per_session/);
  });

  test("add on a name that exists points at the update action", async () => {
    const { settings } = tool(withNames);
    const result = await settings.handler({
      spreadsheet_id: FAKE_ID,
      action: "add_named_range",
      sheet: "Assumptions",
      name: "Fee_per_session",
      range: "B9",
    });
    expect(errorOf(result)?.code).toBe("invalid_argument");
    expect(result.content[0].text).toMatch(/update_named_range/);
  });

  test("update repoints and renames", async () => {
    const { settings, requests } = tool(withNames);
    await settings.handler({
      spreadsheet_id: FAKE_ID,
      action: "update_named_range",
      sheet: "Workings",
      name: "Fee_per_session",
      new_name: "Vendor rate",
      range: "C2",
    });
    const [update] = requestsOfKind<{ namedRange: Record<string, never>; fields: string }>(
      requests(),
      "updateNamedRange",
    );
    expect(update.fields).toBe("range,name");
    expect(update.namedRange["name"]).toBe("Vendor_rate");
    expect(update.namedRange["range"]).toMatchObject({ sheetId: 1 });
  });

  test("delete warns that formulas pointing at it will break", async () => {
    const { settings, requests } = tool(withNames);
    const result = await settings.handler({
      spreadsheet_id: FAKE_ID,
      action: "delete_named_range",
      name: "Fee_per_session",
    });
    expect(requestsOfKind(requests(), "deleteNamedRange")[0]).toEqual({ namedRangeId: "nr1" });
    expect(result.content[0].text).toMatch(/#NAME\?/);
  });

  test("deleting one that does not exist lists the ones that do", async () => {
    const { settings } = tool(withNames);
    const result = await settings.handler({
      spreadsheet_id: FAKE_ID,
      action: "delete_named_range",
      name: "Nope",
    });
    expect(errorOf(result)?.code).toBe("not_found");
    expect(result.content[0].text).toMatch(/Fee_per_session/);
  });
});

describe("date values", () => {
  test("an ISO date becomes the serial Sheets stores", () => {
    // 1899-12-30 is day zero, and 2026-09-07 is 46272 days after it.
    expect(dateSerial("1899-12-30")).toBe(0);
    expect(dateSerial("2026-09-07")).toBe(46272);
    expect(dateSerial("the seventh")).toBeUndefined();
  });

  test("a date formatted row is written as a number so it can be sorted", async () => {
    const { settings, requests } = tool();
    await settings.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Assumptions",
      items: [{ label: "First day", value: "2026-09-07", format: "date" }],
    });
    const cells = requestsOfKind<{ rows: Array<{ values: Array<Record<string, never>> }> }>(
      requests(),
      "updateCells",
    );
    expect(cells[cells.length - 1].rows[0].values[1]["userEnteredValue"]).toEqual({
      numberValue: 46272,
    });
  });
});
