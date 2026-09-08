/**
 * `sheets_table`, exercised against the mutable fake.
 *
 * The assertions worth reading are the refusals: no footer colour, no rewrite
 * of somebody else's dropdown, no status fills on a sheet the plugin did not
 * create, and no delete without the Table's name typed back.
 *
 * All ids and names are invented.
 */
import { describe, expect, test } from "vitest";

import { errorOf, isFailure } from "../src/lib/result.js";
import { createTableTool } from "../src/tools/table.js";
import {
  columnMetadata,
  FAKE_ID,
  makeMutableContext,
  requestsOfKind,
  sheetMetadata,
  type FakeWorkbook,
} from "./helpers/fakeMutableContext.js";

const ROSTER: FakeWorkbook = {
  title: "Fall roster",
  tabs: [
    {
      title: "Instructors",
      sheetId: 0,
      cells: [
        ["Instructor", "Vendor", "Status", "Sessions", "Fee"],
        ["Nadia Okonkwo", "Bright Circuits", "Confirmed", "8", "440"],
        ["Emil Sandoval", "Bright Circuits", "Pending", "8", "440"],
      ],
    },
  ],
};

function tool(workbook: FakeWorkbook = ROSTER, registryJson?: string) {
  const { context, calls, requests } = makeMutableContext(workbook, registryJson);
  return { table: createTableTool({ getContext: async () => context }), calls, requests };
}

const COLUMNS = [
  { name: "Instructor", role: "key" as const, key: "instructor" },
  { name: "Vendor" },
  { name: "Status", type: "DROPDOWN" as const, options: ["Confirmed", "Pending", "Declined"], role: "status" as const },
  { name: "Sessions", type: "DOUBLE" as const },
  { name: "Fee", type: "CURRENCY" as const, note: "Vendor rate times sessions. Not the family fee." },
];

describe("sheets_table create", () => {
  test("adds the Table with header and band colours and no footer", async () => {
    const { table, requests } = tool();
    const result = await table.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Instructors",
      action: "create",
      name: "Instructors",
      range: "A1:E3",
      columns: COLUMNS,
    });
    expect(isFailure(result)).toBe(false);

    const [added] = requestsOfKind<{ table: Record<string, never> }>(requests(), "addTable");
    const rowsProperties = added.table["rowsProperties"] as Record<string, unknown>;
    expect(Object.keys(rowsProperties).sort()).toEqual([
      "firstBandColorStyle",
      "headerColorStyle",
      "secondBandColorStyle",
    ]);
    // footerColorStyle overwrites the last data row with SUM formulas (spike 3).
    expect(JSON.stringify(added)).not.toContain("footer");
  });

  test("types the columns and gives the dropdown its options", async () => {
    const { table, requests } = tool();
    await table.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Instructors",
      action: "create",
      name: "Instructors",
      range: "A1:E3",
      columns: COLUMNS,
    });
    const [added] = requestsOfKind<{ table: Record<string, never> }>(requests(), "addTable");
    const properties = added.table["columnProperties"] as Array<Record<string, never>>;
    expect(properties.map((c) => c["columnType"])).toEqual([
      undefined,
      undefined,
      "DROPDOWN",
      "DOUBLE",
      "CURRENCY",
    ]);
    expect(properties[2]["dataValidationRule"]).toMatchObject({
      condition: { type: "ONE_OF_LIST" },
    });
  });

  test("freezes the header, attaches the filter by tableId, and protects the header row", async () => {
    const { table, requests } = tool();
    await table.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Instructors",
      action: "create",
      name: "Instructors",
      range: "A1:E3",
      columns: COLUMNS,
    });
    const all = requests();
    expect(requestsOfKind(all, "updateSheetProperties")[0]).toMatchObject({
      properties: { gridProperties: { frozenRowCount: 1 } },
    });
    // Binding the filter to the tableId is what makes it follow the Table as
    // rows are added, and it is why create needs a second round trip.
    expect(requestsOfKind(all, "setBasicFilter")[0]).toEqual({ filter: { tableId: "table-1" } });
    const [protection] = requestsOfKind<{ protectedRange: Record<string, never> }>(
      all,
      "addProtectedRange",
    );
    expect(protection.protectedRange["warningOnly"]).toBe(true);
    expect(protection.protectedRange["range"]).toMatchObject({ startRowIndex: 0, endRowIndex: 1 });
  });

  test("writes a header note", async () => {
    const { table, requests } = tool();
    await table.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Instructors",
      action: "create",
      name: "Instructors",
      range: "A1:E3",
      columns: COLUMNS,
    });
    const notes = requestsOfKind<{ rows: Array<{ values: Array<Record<string, string>> }> }>(
      requests(),
      "updateCells",
    );
    expect(notes[0].rows[0].values[4]["note"]).toMatch(/Vendor rate times sessions/);
  });

  test("sends no number format for a typed column, and says why", async () => {
    // A Table column type overrides any pattern written into its cells: the
    // pattern comes back stripped. Verified live on 2026-09-07.
    const { table, requests, calls } = tool();
    const result = await table.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Instructors",
      action: "create",
      name: "Instructors",
      range: "A1:E3",
      columns: COLUMNS,
    });
    expect(requestsOfKind(requests(), "repeatCell")).toHaveLength(0);
    expect(result.content[0].text).toMatch(/overrides the neutral preset's number patterns/);
    expect(calls.batchUpdate).toHaveLength(2);
  });

  test("writes column, sheet and manifest metadata at PROJECT visibility", async () => {
    const { table, requests } = tool();
    await table.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Instructors",
      action: "create",
      name: "Instructors",
      range: "A1:E3",
      columns: COLUMNS,
    });
    const created = requestsOfKind<{ developerMetadata: Record<string, string> }>(
      requests(),
      "createDeveloperMetadata",
    );
    const keys = created.map((c) => c.developerMetadata["metadataKey"]);
    expect(keys.filter((k) => k === "gsheets.column")).toHaveLength(5);
    expect(keys).toContain("gsheets.sheet");
    expect(keys).toContain("gsheets.manifest");
    expect(created.every((c) => c.developerMetadata["visibility"] === "PROJECT")).toBe(true);

    const record = JSON.parse(
      created.find((c) => c.developerMetadata["metadataKey"] === "gsheets.sheet")!.developerMetadata[
        "metadataValue"
      ],
    );
    expect(record.origin).toBe("plugin");
    expect(record.keyColumn).toBe("A");
  });

  test("an existing Table over the same range is a refusal, not a second Table", async () => {
    const busy: FakeWorkbook = {
      tabs: [
        {
          ...ROSTER.tabs[0],
          tables: [
            {
              tableId: "t1",
              name: "Instructors",
              range: { sheetId: 0, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 5 },
            },
          ],
        },
      ],
    };
    const { table } = tool(busy);
    const result = await table.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Instructors",
      action: "create",
      name: "Roster",
      range: "A1:E3",
      columns: COLUMNS,
    });
    expect(isFailure(result)).toBe(true);
    expect(result.content[0].text).toMatch(/already covers/);
  });

  test("an open ended range is refused before anything is sent", async () => {
    const { table, calls } = tool();
    const result = await table.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Instructors",
      action: "create",
      name: "Instructors",
      range: "A:E",
      columns: COLUMNS,
    });
    expect(errorOf(result)?.code).toBe("bad_range");
    expect(calls.batchUpdate).toHaveLength(0);
  });

  test("columns are read off the header row when they are not given", async () => {
    const { table, requests } = tool();
    const result = await table.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Instructors",
      action: "create",
      name: "Instructors",
      range: "A1:E3",
    });
    expect(isFailure(result)).toBe(false);
    const [added] = requestsOfKind<{ table: Record<string, never> }>(requests(), "addTable");
    const properties = added.table["columnProperties"] as Array<Record<string, string>>;
    expect(properties.map((c) => c["columnName"])).toEqual([
      "Instructor",
      "Vendor",
      "Status",
      "Sessions",
      "Fee",
    ]);
  });

  test("a dry run sends nothing and says what it would do", async () => {
    const { table, calls } = tool();
    const result = await table.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Instructors",
      action: "create",
      name: "Instructors",
      range: "A1:E3",
      columns: COLUMNS,
      dry_run: true,
    });
    expect(calls.batchUpdate).toHaveLength(0);
    expect(result.content[0].text).toMatch(/Dry run/);
  });
});

describe("status fills", () => {
  test("are painted on a sheet the plugin is creating, one rule per option", async () => {
    const { table, requests } = tool();
    const result = await table.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Instructors",
      action: "create",
      name: "Instructors",
      range: "A1:E3",
      columns: COLUMNS,
      status_fill_rules: true,
    });
    const rules = requestsOfKind<{ rule: Record<string, never> }>(requests(), "addConditionalFormatRule");
    expect(rules).toHaveLength(3);
    const fills = (result.structuredContent as Record<string, never>)["status_fills"] as Array<{
      option: string;
      role: string;
      fingerprint: string;
    }>;
    expect(fills.map((f) => `${f.option}:${f.role}`)).toEqual([
      "Confirmed:ok",
      "Pending:warn",
      "Declined:flag",
    ]);
    expect(fills[0].fingerprint).toMatch(/^cf_/);
  });

  test("are refused on a tab that already carries somebody's rules, and the reason is reported", async () => {
    const busy: FakeWorkbook = {
      tabs: [{ ...ROSTER.tabs[0], conditionalFormats: [{ ranges: [] }] }],
    };
    const { table, requests } = tool(busy);
    const result = await table.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Instructors",
      action: "create",
      name: "Instructors",
      range: "A1:E3",
      columns: COLUMNS,
      status_fill_rules: true,
    });
    expect(requestsOfKind(requests(), "addConditionalFormatRule")).toHaveLength(0);
    expect(result.content[0].text).toMatch(/somebody else's sheet/);
  });
});

describe("sheets_table adopt", () => {
  const HAND_MADE: FakeWorkbook = {
    tabs: [
      {
        title: "Tracker",
        sheetId: 4,
        cells: [
          ["Instructor", "Vendor", "Status"],
          ["Nadia Okonkwo", "Bright Circuits", { value: "Confirmed", validation: { type: "ONE_OF_LIST", values: ["Confirmed", "Pending"] } }],
          [{ value: "Emil Sandoval", fill: "#ddccff" }, "Bright Circuits", "Pending"],
        ],
      },
    ],
  };

  test("writes metadata and notes and nothing else", async () => {
    const { table, requests } = tool(HAND_MADE);
    const result = await table.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Tracker",
      action: "adopt",
      range: "A1:C3",
      columns: [
        { name: "Instructor", role: "key" },
        { name: "Vendor" },
        { name: "Status", role: "status", note: "Set by the vendor, not by us." },
      ],
    });
    expect(isFailure(result)).toBe(false);
    const kinds = requests().flatMap((r) => Object.keys(r as object));
    expect(new Set(kinds)).toEqual(new Set(["updateCells", "createDeveloperMetadata"]));
    expect(kinds).not.toContain("addTable");
    expect(kinds).not.toContain("addProtectedRange");
    expect(kinds).not.toContain("setBasicFilter");
  });

  test("reports hand set fills rather than clearing them", async () => {
    const { table } = tool(HAND_MADE);
    const result = await table.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Tracker",
      action: "adopt",
      range: "A1:C3",
    });
    const filled = (result.structuredContent as Record<string, never>)["hand_filled_cells"] as string[];
    expect(filled).toEqual(["A3"]);
    expect(result.content[0].text).toMatch(/look patchy/);
  });

  test("reports a dropdown it did not create", async () => {
    const { table } = tool(HAND_MADE);
    const result = await table.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Tracker",
      action: "adopt",
      range: "A1:C3",
    });
    expect((result.structuredContent as Record<string, never>)["ui_owned_columns"]).toEqual(["C"]);
  });

  test("records the sheet as adopted, which blocks status fills later", async () => {
    const { table, requests } = tool(HAND_MADE);
    await table.handler({ spreadsheet_id: FAKE_ID, sheet: "Tracker", action: "adopt", range: "A1:C3" });
    const created = requestsOfKind<{ developerMetadata: Record<string, string> }>(
      requests(),
      "createDeveloperMetadata",
    );
    const record = JSON.parse(
      created.find((c) => c.developerMetadata["metadataKey"] === "gsheets.sheet")!.developerMetadata[
        "metadataValue"
      ],
    );
    expect(record.origin).toBe("adopted");
  });
});

describe("sheets_table update", () => {
  const WITH_TABLE: FakeWorkbook = {
    tabs: [
      {
        ...ROSTER.tabs[0],
        tables: [
          {
            tableId: "t1",
            name: "Instructors",
            range: { sheetId: 0, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 5 },
            columnProperties: [
              { columnIndex: 0, columnName: "Instructor" },
              { columnIndex: 1, columnName: "Vendor" },
              {
                columnIndex: 2,
                columnName: "Status",
                columnType: "DROPDOWN",
                dataValidationRule: {
                  condition: { type: "ONE_OF_LIST", values: [{ userEnteredValue: "Confirmed" }] },
                },
              },
              { columnIndex: 3, columnName: "Sessions", columnType: "DOUBLE" },
              { columnIndex: 4, columnName: "Fee", columnType: "CURRENCY" },
            ],
          },
        ],
      },
    ],
  };

  test("refuses to rewrite a dropdown the plugin did not create", async () => {
    const { table, calls } = tool(WITH_TABLE);
    const result = await table.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Instructors",
      action: "update",
      name: "Instructors",
      columns: COLUMNS,
    });
    expect(errorOf(result)?.code).toBe("ui_owned");
    expect(result.content[0].text).toMatch(/chip colours/);
    expect(calls.batchUpdate).toHaveLength(0);
  });

  test("force rewrites it and says what was lost", async () => {
    const { table, requests } = tool(WITH_TABLE);
    const result = await table.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Instructors",
      action: "update",
      name: "Instructors",
      columns: COLUMNS,
      force: true,
    });
    expect(isFailure(result)).toBe(false);
    expect(result.content[0].text).toMatch(/losing any chip colours/);
    const [update] = requestsOfKind<{ fields: string }>(requests(), "updateTable");
    expect(update.fields).toContain("columnProperties");
  });

  test("a column the plugin recorded is its own to change", async () => {
    const withRecord: FakeWorkbook = {
      ...WITH_TABLE,
      developerMetadata: [columnMetadata(0, 2, { header: "Status", role: "status" })],
    };
    const { table } = tool(withRecord);
    const result = await table.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Instructors",
      action: "update",
      name: "Instructors",
      columns: COLUMNS,
    });
    expect(isFailure(result)).toBe(false);
  });

  test("with nothing to change it says so rather than sending an empty update", async () => {
    const { table, calls } = tool(WITH_TABLE);
    const result = await table.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Instructors",
      action: "update",
      name: "Instructors",
    });
    expect(errorOf(result)?.code).toBe("invalid_argument");
    expect(calls.batchUpdate).toHaveLength(0);
  });

  test("a missing Table lists the ones that exist", async () => {
    const { table } = tool(WITH_TABLE);
    const result = await table.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Instructors",
      action: "update",
      name: "Vendors",
      columns: COLUMNS,
    });
    expect(errorOf(result)?.code).toBe("not_found");
    expect(result.content[0].text).toMatch(/Instructors/);
  });
});

describe("sheets_table delete", () => {
  const WITH_TABLE: FakeWorkbook = {
    tabs: [
      {
        ...ROSTER.tabs[0],
        tables: [
          {
            tableId: "t1",
            name: "Instructors",
            range: { sheetId: 0, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 5 },
          },
        ],
      },
    ],
  };

  test("needs the Table's name typed back", async () => {
    const { table, calls } = tool(WITH_TABLE);
    const result = await table.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Instructors",
      action: "delete",
      name: "Instructors",
    });
    expect(errorOf(result)?.code).toBe("needs_confirmation");
    expect(calls.batchUpdate).toHaveLength(0);
  });

  test("with the confirmation it deletes the Table and says the values stay", async () => {
    const { table, requests } = tool(WITH_TABLE);
    const result = await table.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Instructors",
      action: "delete",
      name: "Instructors",
      confirm: "Instructors",
    });
    expect(requestsOfKind(requests(), "deleteTable")[0]).toEqual({ tableId: "t1" });
    expect(result.content[0].text).toMatch(/values stay/);
  });
});

describe("preset resolution", () => {
  test("the preset the sheet records is used without being asked for", async () => {
    const parkSheet: FakeWorkbook = {
      ...ROSTER,
      developerMetadata: [sheetMetadata(0, { preset: "park", origin: "plugin" })],
    };
    const { table, requests } = tool(parkSheet);
    const result = await table.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Instructors",
      action: "create",
      name: "Instructors",
      range: "A1:E3",
      columns: COLUMNS,
    });
    expect((result.structuredContent as Record<string, never>)["preset"]).toBe("park");
    expect(requestsOfKind(requests(), "addTable")).toHaveLength(1);
  });
});
