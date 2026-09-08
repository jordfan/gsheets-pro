/**
 * The two tools, exercised against a fake Sheets client.
 *
 * All ids and names here are invented.
 */
import { describe, expect, test } from "vitest";

import { errorOf, isFailure } from "../src/lib/result.js";
import { METADATA_KEYS } from "../src/lib/contract.js";
import { createOpenTool } from "../src/tools/open.js";
import { createReadTool, DETAIL_CELL_CAP } from "../src/tools/read.js";
import {
  FAKE_SPREADSHEET_ID,
  makeFakeContext,
  type FakeSpreadsheet,
} from "./helpers/fakeContext.js";

const ROSTER: FakeSpreadsheet = {
  title: "Fall Enrichment Roster",
  tabs: [
    {
      title: "Roster",
      sheetId: 0,
      index: 0,
      frozenRowCount: 1,
      rowCount: 200,
      columnCount: 8,
      values: [
        ["Student", "Grade", "Class", "Fee", "Status"],
        ["Ana Reyes", "3", "Clay Studio", "$120", "Enrolled"],
        ["Bo Tran", "4", "Chess Club", "$120", "Enrolled"],
        ["Cy Okafor", "5", "Clay Studio", "$160", "Waitlist"],
      ],
      formulas: [
        ["Student", "Grade", "Class", "Fee", "Status"],
        ["Ana Reyes", "3", "Clay Studio", "=D$8*1", "Enrolled"],
        ["Bo Tran", "4", "Chess Club", "120", "Enrolled"],
        ["Cy Okafor", "5", "Clay Studio", "160", "Waitlist"],
      ],
      validation: { 4: { type: "ONE_OF_LIST", values: ["Enrolled", "Waitlist", "Dropped"] } },
      bandedRanges: [{ bandedRangeId: 1 }],
    },
    {
      title: "Notes",
      sheetId: 1,
      index: 1,
      values: [["A note about Clay Studio"], ["Another line"]],
    },
  ],
  namedRanges: [{ name: "FeeTable", range: { sheetId: 0, startRowIndex: 7, endRowIndex: 10 } }],
};

const REGISTRY_JSON = JSON.stringify({
  spreadsheets: {
    [FAKE_SPREADSHEET_ID]: {
      name: "Fall Enrichment Roster",
      owner: "shared",
      writable_columns: ["A:C"],
      colleague_safe_text: true,
    },
  },
});

function tools(spreadsheet: FakeSpreadsheet = ROSTER, registryJson?: string) {
  const { context, calls } = makeFakeContext(spreadsheet, registryJson);
  const deps = { getContext: async () => context };
  return { open: createOpenTool(deps), read: createReadTool(deps), calls, context };
}

// ---------------------------------------------------------------------------
// sheets_open
// ---------------------------------------------------------------------------

describe("sheets_open", () => {
  test("maps the tabs, with prose and structure", async () => {
    const { open } = tools();
    const result = await open.handler({ spreadsheet_id: FAKE_SPREADSHEET_ID });
    expect(isFailure(result)).toBe(false);

    const s = result.structuredContent as Record<string, never>;
    expect((s["spreadsheet"] as { title: string }).title).toBe("Fall Enrichment Roster");
    expect(s["allTabs"]).toEqual(["Roster", "Notes"]);
    expect(result.content[0].text).toContain("Fall Enrichment Roster");
    expect(result.content[0].text).toContain("Roster");
  });

  test("reports the headers it found and the row they sit on", async () => {
    const { open } = tools();
    const result = await open.handler({ spreadsheet_id: FAKE_SPREADSHEET_ID });
    const tabs = (result.structuredContent as Record<string, never>)["tabs"] as Array<{
      name: string;
      headers: string[];
      conventions: { headerRow?: number; keyColumn?: string };
    }>;
    const roster = tabs.find((t) => t.name === "Roster")!;
    expect(roster.headers).toEqual(["Student", "Grade", "Class", "Fee", "Status"]);
    expect(roster.conventions.headerRow).toBe(1);
    expect(roster.conventions.keyColumn).toBe("A");
  });

  test("with no registry and no metadata it says there is no contract", async () => {
    const { open } = tools();
    const result = await open.handler({ spreadsheet_id: FAKE_SPREADSHEET_ID });
    const tabs = (result.structuredContent as Record<string, never>)["tabs"] as Array<{
      contract: { source: string; summary: string };
    }>;
    expect(tabs[0].contract.source).toBe("none");
    expect(tabs[0].contract.summary).toMatch(/No contract/);
  });

  test("a registry entry marks the columns that are not ours", async () => {
    const { open } = tools(ROSTER, REGISTRY_JSON);
    const result = await open.handler({ spreadsheet_id: FAKE_SPREADSHEET_ID });
    const tabs = (result.structuredContent as Record<string, never>)["tabs"] as Array<{
      contract: { source: string; columns: Array<{ letter: string; writable: boolean }> };
    }>;
    expect(tabs[0].contract.source).toBe("registry");
    expect(tabs[0].contract.columns.map((c) => c.writable)).toEqual([true, true, true, false, false]);
    expect(result.content[0].text).toContain("Registry");
  });

  test("a dropdown the plugin did not create is reported as the human's", async () => {
    const { open } = tools();
    const result = await open.handler({ spreadsheet_id: FAKE_SPREADSHEET_ID });
    const s = result.structuredContent as Record<string, never>;
    const tabs = s["tabs"] as Array<{ validation: Array<{ column: string; uiOwned: boolean }> }>;
    expect(tabs[0].validation[0]).toMatchObject({ column: "E", uiOwned: true });
    expect((s["warnings"] as string[]).some((w) => w.includes("set outside this plugin"))).toBe(true);
  });

  test("a dropdown on a column with plugin metadata is not flagged", async () => {
    const withMetadata: FakeSpreadsheet = {
      ...ROSTER,
      developerMetadata: [
        {
          metadataKey: METADATA_KEYS.column,
          metadataValue: JSON.stringify({ name: "status", role: "status" }),
          location: { dimensionRange: { sheetId: 0, dimension: "COLUMNS", startIndex: 4 } },
        },
      ],
    };
    const { open } = tools(withMetadata);
    const result = await open.handler({ spreadsheet_id: FAKE_SPREADSHEET_ID });
    const tabs = (result.structuredContent as Record<string, never>)["tabs"] as Array<{
      validation: Array<{ uiOwned: boolean }>;
      contract: { source: string };
    }>;
    expect(tabs[0].validation[0].uiOwned).toBe(false);
    expect(tabs[0].contract.source).toBe("metadata");
  });

  test("metadata that cannot be read is a warning, not a failure", async () => {
    const { open } = tools({ ...ROSTER, metadataThrows: true });
    const result = await open.handler({ spreadsheet_id: FAKE_SPREADSHEET_ID });
    expect(isFailure(result)).toBe(false);
    const warnings = (result.structuredContent as Record<string, never>)["warnings"] as string[];
    expect(warnings.some((w) => w.includes("Developer metadata"))).toBe(true);
  });

  test("named ranges come back", async () => {
    const { open } = tools();
    const result = await open.handler({ spreadsheet_id: FAKE_SPREADSHEET_ID });
    const named = (result.structuredContent as Record<string, never>)["namedRanges"] as Array<{
      name: string;
    }>;
    expect(named.map((n) => n.name)).toEqual(["FeeTable"]);
  });

  test("one tab can be inspected on its own", async () => {
    const { open } = tools();
    const result = await open.handler({ spreadsheet_id: FAKE_SPREADSHEET_ID, sheet: "Notes" });
    const tabs = (result.structuredContent as Record<string, never>)["tabs"] as Array<{ name: string }>;
    expect(tabs.map((t) => t.name)).toEqual(["Notes"]);
  });

  test("a tab that does not exist names the ones that do", async () => {
    const { open } = tools();
    const result = await open.handler({ spreadsheet_id: FAKE_SPREADSHEET_ID, sheet: "Rostr" });
    expect(errorOf(result)?.code).toBe("sheet_not_found");
    expect(errorOf(result)?.hint).toContain("Roster, Notes");
  });

  test("no id and no create is an error that explains both", async () => {
    const { open } = tools();
    const result = await open.handler({});
    expect(errorOf(result)?.code).toBe("invalid_argument");
    expect(errorOf(result)?.hint).toMatch(/create/);
  });

  test("create makes a spreadsheet and reports it", async () => {
    const { open, calls } = tools();
    const result = await open.handler({ create: { title: "New Tracker", tabs: ["Current", "Archive"] } });
    expect(calls.create).toHaveLength(1);
    expect(result.content[0].text).toMatch(/^Created/);
  });

  test("the tab cache is primed from the open, so the next call spends no read", async () => {
    const { open, read, calls } = tools();
    await open.handler({ spreadsheet_id: FAKE_SPREADSHEET_ID });
    const before = calls.get.length;
    await read.handler({ spreadsheet_id: FAKE_SPREADSHEET_ID, sheet: "Roster" });
    // The read's own values.batchGet is a batchGet, not a get. No extra
    // spreadsheets.get should have been needed to resolve the tab name.
    expect(calls.get.length).toBe(before);
  });

  test("the result declares a size budget, because a wide workbook is big", async () => {
    const { open } = tools();
    const result = await open.handler({ spreadsheet_id: FAKE_SPREADSHEET_ID });
    expect(result._meta?.["anthropic/maxResultSizeChars"]).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// sheets_read
// ---------------------------------------------------------------------------

describe("sheets_read", () => {
  test("returns records keyed by header with the true sheet row", async () => {
    const { read } = tools();
    const result = await read.handler({ spreadsheet_id: FAKE_SPREADSHEET_ID, sheet: "Roster" });
    const s = result.structuredContent as Record<string, never>;
    expect(s["headers"]).toEqual(["Student", "Grade", "Class", "Fee", "Status"]);
    const records = s["records"] as Array<Record<string, unknown>>;
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ _row: 2, Student: "Ana Reyes", Status: "Enrolled" });
    expect(records[2]._row).toBe(4);
  });

  test("grid mode returns raw rows", async () => {
    const { read } = tools();
    const result = await read.handler({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      sheet: "Roster",
      as: "grid",
    });
    const s = result.structuredContent as Record<string, never>;
    expect(s["shape"]).toBe("grid");
    expect((s["rows"] as unknown[]).length).toBe(4);
  });

  test("where filters and never renumbers _row", async () => {
    const { read } = tools();
    const result = await read.handler({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      sheet: "Roster",
      where: [{ column: "Class", op: "eq", value: "clay studio" }],
    });
    const records = (result.structuredContent as Record<string, never>)["records"] as Array<{
      _row: number;
    }>;
    expect(records.map((r) => r._row)).toEqual([2, 4]);
  });

  test("columns narrows the record without losing _row", async () => {
    const { read } = tools();
    const result = await read.handler({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      sheet: "Roster",
      columns: ["Student", "Status"],
    });
    const records = (result.structuredContent as Record<string, never>)["records"] as Array<
      Record<string, unknown>
    >;
    expect(Object.keys(records[0]).sort()).toEqual(["Status", "Student", "_row"]);
  });

  test("a column that does not exist names the ones that do", async () => {
    const { read } = tools();
    const result = await read.handler({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      sheet: "Roster",
      columns: ["Nickname"],
    });
    expect(errorOf(result)?.code).toBe("invalid_argument");
    expect(errorOf(result)?.hint).toContain("Student, Grade");
  });

  test("formulas come back as formulas", async () => {
    const { read } = tools();
    const result = await read.handler({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      sheet: "Roster",
      values: "formulas",
      as: "grid",
    });
    const rows = (result.structuredContent as Record<string, never>)["rows"] as unknown[][];
    expect(rows[1][3]).toBe("=D$8*1");
  });

  test("both puts the displayed value and the formula side by side", async () => {
    const { read } = tools();
    const result = await read.handler({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      sheet: "Roster",
      values: "both",
    });
    const records = (result.structuredContent as Record<string, never>)["records"] as Array<
      Record<string, unknown>
    >;
    expect(records[0]["Fee"]).toBe("$120");
    expect(records[0]["_formulas"]).toEqual({ Fee: "=D$8*1" });
    expect(records[1]["_formulas"]).toBeUndefined();
  });

  test("a range shifts the row numbers to the truth", async () => {
    const { read } = tools();
    const result = await read.handler({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      sheet: "Roster",
      range: "A2:E4",
      header_row: 2,
    });
    const s = result.structuredContent as Record<string, never>;
    expect(s["header_row"]).toBe(2);
    const records = s["records"] as Array<{ _row: number }>;
    expect(records[0]._row).toBe(3);
  });

  test("a header row outside the range is refused with the arithmetic explained", async () => {
    const { read } = tools();
    const result = await read.handler({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      sheet: "Roster",
      range: "A2:E4",
      header_row: 1,
    });
    expect(errorOf(result)?.code).toBe("invalid_argument");
    expect(errorOf(result)?.hint).toMatch(/starts at row 2/);
  });

  test("a bad range is caught here, with our message", async () => {
    const { read } = tools();
    const result = await read.handler({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      sheet: "Roster",
      range: "banana",
    });
    expect(isFailure(result)).toBe(true);
    expect(errorOf(result)?.message).toMatch(/Could not parse A1 range/);
  });

  test("pagination reports the total and the next offset", async () => {
    const { read } = tools();
    const result = await read.handler({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      sheet: "Roster",
      limit: 2,
    });
    const page = (result.structuredContent as Record<string, never>)["pagination"] as {
      total: number;
      next_offset: number | null;
    };
    expect(page.total).toBe(3);
    expect(page.next_offset).toBe(2);
    expect(result.content[0].text).toContain("offset 2");
  });

  test("the last page reports no next offset", async () => {
    const { read } = tools();
    const result = await read.handler({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      sheet: "Roster",
      limit: 2,
      offset: 2,
    });
    const page = (result.structuredContent as Record<string, never>)["pagination"] as {
      next_offset: number | null;
    };
    expect(page.next_offset).toBeNull();
  });

  test("a missing sheet argument says what to pass", async () => {
    const { read } = tools();
    const result = await read.handler({ spreadsheet_id: FAKE_SPREADSHEET_ID });
    expect(errorOf(result)?.code).toBe("invalid_argument");
    expect(errorOf(result)?.hint).toMatch(/find/);
  });

  test("find searches every visible tab", async () => {
    const { read } = tools();
    const result = await read.handler({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      find: { query: "clay studio" },
    });
    const s = result.structuredContent as Record<string, never>;
    expect(s["searched"]).toEqual(["Roster", "Notes"]);
    const hits = s["hits"] as Array<{ sheet: string; cell: string }>;
    expect(hits.map((h) => `${h.sheet}!${h.cell}`)).toEqual(["Roster!C2", "Roster!C4", "Notes!A1"]);
  });

  test("find can be limited to named tabs", async () => {
    const { read } = tools();
    const result = await read.handler({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      find: { query: "clay", in_sheets: ["Notes"] },
    });
    expect((result.structuredContent as Record<string, never>)["searched"]).toEqual(["Notes"]);
  });

  test("find reports nothing found in plain words", async () => {
    const { read } = tools();
    const result = await read.handler({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      find: { query: "zzzz" },
    });
    expect(result.content[0].text).toMatch(/^No cell contains/);
  });

  test("detail reads are capped rather than truncated silently", async () => {
    const { read } = tools();
    const result = await read.handler({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      sheet: "Roster",
      range: "A1:Z100",
      include: { formats: true },
    });
    const warnings = (result.structuredContent as Record<string, never>)["warnings"] as string[];
    expect(warnings[0]).toContain(String(DETAIL_CELL_CAP));
  });

  test("an open ended range refuses the detail read with a reason", async () => {
    const { read } = tools();
    const result = await read.handler({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      sheet: "Roster",
      range: "A:E",
      include: { notes: true },
    });
    const warnings = (result.structuredContent as Record<string, never>)["warnings"] as string[];
    expect(warnings[0]).toMatch(/open ended/);
  });

  test("a small detail read comes back with validation flagged as the human's", async () => {
    const { read } = tools();
    const result = await read.handler({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      sheet: "Roster",
      range: "A1:E4",
      include: { validation: true },
    });
    const detail = (result.structuredContent as Record<string, never>)["detail"] as {
      validation: Record<string, { ui_owned: boolean }>;
    };
    expect(Object.keys(detail.validation).length).toBeGreaterThan(0);
    expect(Object.values(detail.validation)[0].ui_owned).toBe(true);
  });

  test("the result declares a size budget", async () => {
    const { read } = tools();
    const result = await read.handler({ spreadsheet_id: FAKE_SPREADSHEET_ID, sheet: "Roster" });
    expect(result._meta?.["anthropic/maxResultSizeChars"]).toBeGreaterThan(0);
  });
});
