/**
 * `sheets_structure`, exercised against a fake Sheets client.
 *
 * All ids and names here are invented.
 */
import { describe, expect, test } from "vitest";

import { errorOf, isFailure } from "../src/lib/result.js";
import { createStructureTool } from "../src/tools/structure.js";
import {
  MUT_SPREADSHEET_ID,
  makeMutationContext,
  onlyRequest,
  type FakeMutationOptions,
  type MutSpreadsheet,
} from "./helpers/fakeMutations.js";

const BOOK: MutSpreadsheet = {
  title: "Fall Enrichment",
  tabs: [
    {
      title: "Roster",
      sheetId: 0,
      index: 0,
      frozenRowCount: 1,
      rowCount: 200,
      columnCount: 6,
      headers: ["Student", "Grade", "Class", "Fee", "Status", "Notes"],
    },
    {
      title: "Fees",
      sheetId: 1,
      index: 1,
      formulaCells: ["B2"],
    },
    {
      title: "Locked",
      sheetId: 2,
      index: 2,
      frozenRowCount: 1,
      protectedRanges: [
        { protectedRangeId: 77, range: { sheetId: 2, startColumnIndex: 10, endColumnIndex: 16 }, description: "HR keeps K to P", warningOnly: true },
        { protectedRangeId: 78, description: "whole tab" },
      ],
    },
  ],
};

const POSITIONAL_REGISTRY = JSON.stringify({
  spreadsheets: {
    [MUT_SPREADSHEET_ID]: {
      name: "Private Lessons draft schedule",
      owner: "human",
      positional_rows: true,
    },
  },
});

const COLUMN_REGISTRY = JSON.stringify({
  spreadsheets: {
    [MUT_SPREADSHEET_ID]: {
      name: "Background Check Tracker",
      owner: "shared",
      writable_columns: ["A:C"],
    },
  },
});

function tool(spreadsheet: MutSpreadsheet = BOOK, options: FakeMutationOptions = {}) {
  const { context, calls } = makeMutationContext(spreadsheet, options);
  return { structure: createStructureTool({ getContext: async () => context }), calls, context };
}

async function run(args: Record<string, unknown>, spreadsheet?: MutSpreadsheet, options?: FakeMutationOptions) {
  const t = tool(spreadsheet, options);
  const response = await t.structure.handler({ spreadsheet_id: MUT_SPREADSHEET_ID, ...args });
  return { response, calls: t.calls };
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

describe("tabs", () => {
  test("add_tab sends addSheet with the title", async () => {
    const { response, calls } = await run({ action: "add_tab", title: "Waitlist", index: 2 });
    expect(isFailure(response)).toBe(false);
    expect(onlyRequest(calls)).toEqual({ addSheet: { properties: { title: "Waitlist", index: 2 } } });
  });

  test("add_tab without a title is a teaching error", async () => {
    const { response } = await run({ action: "add_tab" });
    expect(isFailure(response)).toBe(true);
    expect(errorOf(response)?.code).toBe("invalid_argument");
  });

  test("rename_tab masks only the title, and warns about text references", async () => {
    const { response, calls } = await run({ action: "rename_tab", sheet: "Roster", title: "Fall Roster" });
    expect(onlyRequest(calls)).toEqual({
      updateSheetProperties: { properties: { sheetId: 0, title: "Fall Roster" }, fields: "title" },
    });
    expect(response.content[0].text).toContain("IMPORTRANGE");
  });

  test("hide_tab and show_tab set the same field opposite ways", async () => {
    const hidden = await run({ action: "hide_tab", sheet: "Roster" });
    expect(onlyRequest(hidden.calls)).toMatchObject({
      updateSheetProperties: { properties: { hidden: true }, fields: "hidden" },
    });
    const shown = await run({ action: "show_tab", sheet: "Roster" });
    expect(onlyRequest(shown.calls)).toMatchObject({
      updateSheetProperties: { properties: { hidden: false }, fields: "hidden" },
    });
  });

  test("delete_tab without confirm changes nothing", async () => {
    const { response, calls } = await run({ action: "delete_tab", sheet: "Roster" });
    expect(isFailure(response)).toBe(true);
    expect(errorOf(response)?.code).toBe("needs_confirmation");
    expect(errorOf(response)?.hint).toContain('confirm: "Roster"');
    expect(calls.batchUpdate).toHaveLength(0);
  });

  test("delete_tab with the wrong confirm changes nothing", async () => {
    const { response, calls } = await run({ action: "delete_tab", sheet: "Roster", confirm: "yes" });
    expect(errorOf(response)?.code).toBe("needs_confirmation");
    expect(calls.batchUpdate).toHaveLength(0);
  });

  test("delete_tab with the tab's own name deletes it and gates the remaining tabs", async () => {
    const { response, calls } = await run({ action: "delete_tab", sheet: "Roster", confirm: "roster" });
    expect(isFailure(response)).toBe(false);
    expect(onlyRequest(calls)).toEqual({ deleteSheet: { sheetId: 0 } });
    const gateRead = calls.get.find((g) => g.includeGridData);
    expect(gateRead?.ranges).toEqual(["'Fees'", "'Locked'"]);
    expect(response.content[0].text).toContain("#REF!");
  });

  test("copy_tab_to uses sheets.copyTo, not batchUpdate", async () => {
    const { response, calls } = await run({
      action: "copy_tab_to",
      sheet: "Roster",
      destination_spreadsheet_id: "1OtHeRsPrEaDsHeEtIdAbCdEfGhIjKlMnOpQr",
    });
    expect(isFailure(response)).toBe(false);
    expect(calls.batchUpdate).toHaveLength(0);
    expect(calls.copyTo[0]).toMatchObject({ sheetId: 0, destinationSpreadsheetId: "1OtHeRsPrEaDsHeEtIdAbCdEfGhIjKlMnOpQr" });
    expect(response.content[0].text).toContain("Copy of Roster");
  });

  test("copy_tab_to into the same spreadsheet points at duplicate_tab", async () => {
    const { response } = await run({
      action: "copy_tab_to",
      sheet: "Roster",
      destination_spreadsheet_id: MUT_SPREADSHEET_ID,
    });
    expect(errorOf(response)?.hint).toContain("duplicate_tab");
  });
});

// ---------------------------------------------------------------------------
// Rows and columns
// ---------------------------------------------------------------------------

describe("rows and columns", () => {
  test("insert_rows turns a span into a DimensionRange", async () => {
    const { response, calls } = await run({ action: "insert_rows", sheet: "Roster", rows: "5:7" });
    expect(onlyRequest(calls)).toEqual({
      insertDimension: {
        range: { sheetId: 0, dimension: "ROWS", startIndex: 4, endIndex: 7 },
        inheritFromBefore: true,
      },
    });
    expect(response.content[0].text).toContain("3 rows");
    expect(response.content[0].text).toContain("Grid shift");
  });

  test("insert_rows at row 1 does not inherit from a row above it", async () => {
    const { calls } = await run({ action: "insert_rows", sheet: "Roster", rows: "1" });
    expect(onlyRequest(calls)).toMatchObject({ insertDimension: { inheritFromBefore: false } });
  });

  test("delete_columns needs confirm and then sends deleteDimension", async () => {
    const refused = await run({ action: "delete_columns", sheet: "Roster", columns: "E:F" });
    expect(errorOf(refused.response)?.code).toBe("needs_confirmation");

    const done = await run({ action: "delete_columns", sheet: "Roster", columns: "E:F", confirm: "Roster" });
    expect(onlyRequest(done.calls)).toEqual({
      deleteDimension: { range: { sheetId: 0, dimension: "COLUMNS", startIndex: 4, endIndex: 6 } },
    });
  });

  test("move_rows reads to as the row to land before", async () => {
    const { calls } = await run({ action: "move_rows", sheet: "Roster", rows: "5:7", to: "12" });
    expect(onlyRequest(calls)).toEqual({
      moveDimension: {
        source: { sheetId: 0, dimension: "ROWS", startIndex: 4, endIndex: 7 },
        destinationIndex: 11,
      },
    });
  });

  test("move_columns reads to as a column letter", async () => {
    const { calls } = await run({ action: "move_columns", sheet: "Roster", columns: "E", to: "B" });
    expect(onlyRequest(calls)).toMatchObject({ moveDimension: { destinationIndex: 1 } });
  });

  test("a malformed span is a bad_range error, not an API round trip", async () => {
    const { response, calls } = await run({ action: "insert_rows", sheet: "Roster", rows: "banana" });
    expect(isFailure(response)).toBe(true);
    expect(calls.batchUpdate).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Data actions
// ---------------------------------------------------------------------------

describe("data actions", () => {
  test("sort defaults to everything below the frozen header", async () => {
    const { calls } = await run({ action: "sort", sheet: "Roster", sort_by: [{ column: "B" }] });
    expect(onlyRequest(calls)).toEqual({
      sortRange: {
        range: { sheetId: 0, startRowIndex: 1, endRowIndex: 200, startColumnIndex: 0, endColumnIndex: 6 },
        sortSpecs: [{ dimensionIndex: 1, sortOrder: "ASCENDING" }],
      },
    });
  });

  test("sort resolves a header name to its column index", async () => {
    const { calls } = await run({
      action: "sort",
      sheet: "Roster",
      sort_by: [{ column: "Status", order: "desc" }, { column: "Student" }],
    });
    expect(onlyRequest(calls)).toMatchObject({
      sortRange: {
        sortSpecs: [
          { dimensionIndex: 4, sortOrder: "DESCENDING" },
          { dimensionIndex: 0, sortOrder: "ASCENDING" },
        ],
      },
    });
  });

  test("sort on a tab with no frozen header asks for a range rather than guessing", async () => {
    const { response, calls } = await run({ action: "sort", sheet: "Fees", sort_by: [{ column: "A" }] });
    expect(isFailure(response)).toBe(true);
    expect(errorOf(response)?.message).toContain("no frozen header");
    expect(calls.batchUpdate).toHaveLength(0);
  });

  test("sort with an unknown column names the headers it does have", async () => {
    const { response } = await run({ action: "sort", sheet: "Roster", sort_by: [{ column: "Teacher" }] });
    expect(errorOf(response)?.hint).toContain("Student");
  });

  test("find_replace needs confirm, leaves formulas alone by default, and says so", async () => {
    const refused = await run({ action: "find_replace", sheet: "Roster", find: "Clay", replace: "Ceramics" });
    expect(errorOf(refused.response)?.code).toBe("needs_confirmation");

    const done = await run({
      action: "find_replace",
      sheet: "Roster",
      find: "Clay",
      replace: "Ceramics",
      confirm: "Roster",
    });
    expect(onlyRequest(done.calls)).toEqual({
      findReplace: {
        find: "Clay",
        replacement: "Ceramics",
        matchCase: false,
        matchEntireCell: false,
        searchByRegex: false,
        includeFormulas: false,
        sheetId: 0,
      },
    });
    expect(done.response.content[0].text).toContain("Formulas were left alone");
  });

  test("find_replace with a range scopes to it", async () => {
    const { calls } = await run({
      action: "find_replace",
      sheet: "Roster",
      range: "C2:C50",
      find: "Clay",
      confirm: "Roster",
    });
    expect(onlyRequest(calls)).toMatchObject({
      findReplace: { range: { sheetId: 0, startRowIndex: 1, endRowIndex: 50, startColumnIndex: 2, endColumnIndex: 3 } },
    });
  });

  test("dedupe compares only the named key columns", async () => {
    const { calls } = await run({
      action: "dedupe",
      sheet: "Roster",
      key_columns: ["Student", "Class"],
      confirm: "Roster",
    });
    expect(onlyRequest(calls)).toMatchObject({
      deleteDuplicates: {
        comparisonColumns: [
          { sheetId: 0, dimension: "COLUMNS", startIndex: 0, endIndex: 1 },
          { sheetId: 0, dimension: "COLUMNS", startIndex: 2, endIndex: 3 },
        ],
      },
    });
  });

  test("trim over the whole tab sends a bare sheetId range", async () => {
    const { calls } = await run({ action: "trim", sheet: "Roster" });
    expect(onlyRequest(calls)).toEqual({ trimWhitespace: { range: { sheetId: 0 } } });
  });
});

// ---------------------------------------------------------------------------
// Outline and protection
// ---------------------------------------------------------------------------

describe("grouping and protection", () => {
  test("group takes rows or columns, not both", async () => {
    const { response } = await run({ action: "group", sheet: "Roster", rows: "2:5", columns: "B:C" });
    expect(errorOf(response)?.message).toContain("not both");
  });

  test("group collapsed sends the group and then collapses it, in one batch", async () => {
    const { calls } = await run({ action: "group", sheet: "Roster", rows: "2:5", collapsed: true });
    expect(calls.batchUpdate).toHaveLength(1);
    expect(calls.batchUpdate[0].requests).toHaveLength(2);
  });

  test("protect requires a description a colleague can read", async () => {
    const { response } = await run({ action: "protect", sheet: "Roster", range: "K:P" });
    expect(errorOf(response)?.code).toBe("invalid_argument");
    expect(errorOf(response)?.hint).toContain("colleague");
  });

  test("protect defaults to warning only", async () => {
    const { calls } = await run({
      action: "protect",
      sheet: "Roster",
      range: "K1:P200",
      description: "Hadeer keeps the background check dates here.",
    });
    expect(onlyRequest(calls)).toMatchObject({
      addProtectedRange: { protectedRange: { warningOnly: true, description: "Hadeer keeps the background check dates here." } },
    });
  });

  test("a hard protection needs confirm", async () => {
    const { response } = await run({
      action: "protect",
      sheet: "Roster",
      description: "Nobody but the agent.",
      warning_only: false,
    });
    expect(errorOf(response)?.code).toBe("needs_confirmation");
  });

  test("unprotect finds the protection by description", async () => {
    const { calls } = await run({ action: "unprotect", sheet: "Locked", description: "HR keeps" });
    expect(onlyRequest(calls)).toEqual({ deleteProtectedRange: { protectedRangeId: 77 } });
  });

  test("unprotect with nothing to go on lists the candidates", async () => {
    const { response } = await run({ action: "unprotect", sheet: "Locked" });
    expect(isFailure(response)).toBe(true);
    expect(errorOf(response)?.hint).toContain("HR keeps K to P");
  });
});

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

describe("registry refusals", () => {
  const positional = { registryJson: POSITIONAL_REGISTRY };

  test.each(["insert_rows", "delete_rows", "move_rows", "sort", "dedupe"])(
    "%s is refused on a positional_rows sheet",
    async (action) => {
      const { response, calls } = await run(
        {
          action,
          sheet: "Roster",
          rows: "5:7",
          to: "12",
          sort_by: [{ column: "A" }],
          confirm: "Roster",
        },
        BOOK,
        positional,
      );
      expect(isFailure(response)).toBe(true);
      expect(errorOf(response)?.code).toBe("contract_violation");
      expect(errorOf(response)?.message).toContain("positional");
      expect(calls.batchUpdate).toHaveLength(0);
    },
  );

  test("a column action is still allowed on a positional_rows sheet", async () => {
    const { response, calls } = await run(
      { action: "insert_columns", sheet: "Roster", columns: "G" },
      BOOK,
      positional,
    );
    expect(isFailure(response)).toBe(false);
    expect(calls.batchUpdate).toHaveLength(1);
  });

  test("renaming a tab is allowed on a positional_rows sheet", async () => {
    const { response } = await run(
      { action: "rename_tab", sheet: "Roster", title: "Schedule" },
      BOOK,
      positional,
    );
    expect(isFailure(response)).toBe(false);
  });

  test("delete_columns is refused where the registry reserves columns", async () => {
    const { response, calls } = await run(
      { action: "delete_columns", sheet: "Roster", columns: "E", confirm: "Roster" },
      BOOK,
      { registryJson: COLUMN_REGISTRY },
    );
    expect(errorOf(response)?.code).toBe("contract_violation");
    expect(errorOf(response)?.hint).toContain("renumbers");
    expect(calls.batchUpdate).toHaveLength(0);
  });

  test("inserting left of a reserved column says the registry letters moved", async () => {
    const { response } = await run(
      { action: "insert_columns", sheet: "Roster", columns: "A" },
      BOOK,
      { registryJson: COLUMN_REGISTRY },
    );
    expect(isFailure(response)).toBe(false);
    expect(response.content[0].text).toContain("one letter to the right");
    expect(response.content[0].text).toContain("A:C");
  });

  test("inserting to the right of the reserved columns says nothing about them", async () => {
    const { response } = await run(
      { action: "insert_columns", sheet: "Roster", columns: "E" },
      BOOK,
      { registryJson: COLUMN_REGISTRY },
    );
    expect(response.content[0].text).not.toContain("one letter to the right");
  });

  test("a shared sheet gets a line saying a colleague will see the change", async () => {
    const { response } = await run(
      { action: "rename_tab", sheet: "Roster", title: "Schedule" },
      BOOK,
      { registryJson: COLUMN_REGISTRY },
    );
    expect(response.content[0].text).toContain("colleague will see");
  });
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe("the error gate", () => {
  test("a row delete re-reads the tab and reports what broke", async () => {
    const broken: MutSpreadsheet = {
      tabs: [{ title: "Roster", sheetId: 0, frozenRowCount: 1, errorCells: { B4: "REF" }, formulaCells: ["B4"] }],
    };
    const { response } = await run(
      { action: "delete_rows", sheet: "Roster", rows: "3", confirm: "Roster" },
      broken,
    );
    const structured = response.structuredContent as { check: { status: string; error_summary: Record<string, number> } };
    expect(structured.check.status).toBe("errors_found");
    expect(structured.check.error_summary).toEqual({ REF: 1 });
    expect(response.content[0].text).toContain("REF");
  });

  test("a tab rename runs no gate at all", async () => {
    const { response, calls } = await run({ action: "rename_tab", sheet: "Roster", title: "Fall Roster" });
    expect((response.structuredContent as { check: unknown }).check).toBeNull();
    expect(calls.get.filter((g) => g.includeGridData)).toHaveLength(0);
  });
});
