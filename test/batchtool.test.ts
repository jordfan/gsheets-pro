/**
 * `sheets_batch`, the escape hatch, against a fake Sheets client.
 *
 * All ids and names here are invented.
 */
import { describe, expect, test } from "vitest";

import { errorOf, isFailure } from "../src/lib/result.js";
import { createBatchTool } from "../src/tools/batch.js";
import {
  MUT_SPREADSHEET_ID,
  makeMutationContext,
  type FakeMutationOptions,
  type MutSpreadsheet,
} from "./helpers/fakeMutations.js";

const BOOK: MutSpreadsheet = {
  tabs: [
    { title: "Roster", sheetId: 0, index: 0, frozenRowCount: 1, rowCount: 200, columnCount: 6 },
    { title: "Fees", sheetId: 42, index: 1 },
  ],
};

function tool(spreadsheet: MutSpreadsheet = BOOK, options: FakeMutationOptions = {}) {
  const { context, calls } = makeMutationContext(spreadsheet, options);
  return { batch: createBatchTool({ getContext: async () => context }), calls };
}

describe("sheets_batch", () => {
  test("dry_run resolves and sends nothing", async () => {
    const t = tool();
    const response = await t.batch.handler({
      spreadsheet_id: MUT_SPREADSHEET_ID,
      requests: [{ sortRange: { range: "'Roster'!A2:F80", sortSpecs: [{ dimensionIndex: 1 }] } }],
      dry_run: true,
    });
    expect(isFailure(response)).toBe(false);
    expect(t.calls.batchUpdate).toHaveLength(0);
    const structured = response.structuredContent as {
      resolved_requests: unknown[];
      touched: string[];
      changes_values: boolean;
    };
    expect(structured.resolved_requests[0]).toMatchObject({ sortRange: { range: { sheetId: 0 } } });
    expect(structured.touched).toEqual(["'Roster'!A2:F80"]);
    expect(structured.changes_values).toBe(true);
    expect(response.content[0].text).toContain("nothing sent");
  });

  test("sends every request in one batchUpdate", async () => {
    const t = tool();
    await t.batch.handler({
      spreadsheet_id: MUT_SPREADSHEET_ID,
      requests: [
        { addSheet: { properties: { title: "Charts" } } },
        { sortRange: { range: "'Roster'!A2:F80", sortSpecs: [{ dimensionIndex: 1 }] } },
      ],
    });
    expect(t.calls.batchUpdate).toHaveLength(1);
    expect(t.calls.batchUpdate[0].requests).toHaveLength(2);
  });

  test("runs the gate over the touched ranges when values could change", async () => {
    const broken: MutSpreadsheet = {
      tabs: [{ title: "Roster", sheetId: 0, errorCells: { C3: "REF" }, formulaCells: ["C3"] }],
    };
    const t = tool(broken);
    const response = await t.batch.handler({
      spreadsheet_id: MUT_SPREADSHEET_ID,
      requests: [{ deleteDimension: { range: "'Roster'!B:B" } }],
    });
    const structured = response.structuredContent as { check: { status: string } };
    expect(structured.check.status).toBe("errors_found");
    expect(response.content[0].text).toContain("REF");
  });

  test("a batch that changes no values runs no gate", async () => {
    const t = tool();
    const response = await t.batch.handler({
      spreadsheet_id: MUT_SPREADSHEET_ID,
      requests: [
        { updateSheetProperties: { properties: { sheetId: "Roster", title: "Fall" }, fields: "title" } },
      ],
    });
    expect((response.structuredContent as { check: unknown }).check).toBeNull();
    expect(t.calls.get.filter((g) => g.includeGridData)).toHaveLength(0);
  });

  test("check false turns the gate off", async () => {
    const t = tool();
    const response = await t.batch.handler({
      spreadsheet_id: MUT_SPREADSHEET_ID,
      requests: [{ trimWhitespace: { range: "'Roster'!A1:C10" } }],
      check: false,
    });
    expect((response.structuredContent as { check: unknown }).check).toBeNull();
  });

  test("reminds that the named tools' checks are skipped on a registry sheet", async () => {
    const registryJson = JSON.stringify({
      spreadsheets: {
        [MUT_SPREADSHEET_ID]: {
          name: "Background Check Tracker",
          owner: "shared",
          writable_columns: ["A:C"],
          positional_rows: true,
        },
      },
    });
    const t = tool(BOOK, { registryJson });
    const response = await t.batch.handler({
      spreadsheet_id: MUT_SPREADSHEET_ID,
      requests: [{ deleteDimension: { range: "'Roster'!5:9" } }],
    });
    const text = response.content[0].text;
    expect(text).toContain("shared");
    expect(text).toContain("enforces none of that");
    expect(text).toContain("positional_rows");
  });

  test("says nothing about the registry when there is no entry", async () => {
    const t = tool();
    const response = await t.batch.handler({
      spreadsheet_id: MUT_SPREADSHEET_ID,
      requests: [{ deleteDimension: { range: "'Roster'!5:9" } }],
    });
    expect((response.structuredContent as { warnings: string[] }).warnings).toEqual([]);
  });

  test("an empty request list is refused before any call", async () => {
    const t = tool();
    const response = await t.batch.handler({ spreadsheet_id: MUT_SPREADSHEET_ID, requests: [] });
    expect(isFailure(response)).toBe(true);
    expect(errorOf(response)?.code).toBe("invalid_argument");
    expect(t.calls.batchUpdate).toHaveLength(0);
  });

  test("an unknown tab name fails with our error rather than the API's", async () => {
    const t = tool();
    const response = await t.batch.handler({
      spreadsheet_id: MUT_SPREADSHEET_ID,
      requests: [{ deleteSheet: { sheetId: "Nowhere" } }],
    });
    expect(errorOf(response)?.code).toBe("sheet_not_found");
    expect(t.calls.batchUpdate).toHaveLength(0);
  });

  test("carries back the ids a reply names", async () => {
    const t = tool(BOOK, { replies: [{ addSheet: { properties: { sheetId: 314, title: "Charts" } } }] });
    const response = await t.batch.handler({
      spreadsheet_id: MUT_SPREADSHEET_ID,
      requests: [{ addSheet: { properties: { title: "Charts" } } }],
    });
    const structured = response.structuredContent as { replies: Array<Record<string, unknown>> };
    expect(structured.replies[0]).toMatchObject({
      type: "addSheet",
      sheet: { sheet_id: 314, title: "Charts" },
    });
  });

  test("names the requests the gate cannot cover", async () => {
    const t = tool();
    const response = await t.batch.handler({
      spreadsheet_id: MUT_SPREADSHEET_ID,
      requests: [
        { deleteSheet: { sheetId: "Fees" } },
        { pasteData: { data: "a,b", type: "PASTE_NORMAL", delimiter: "," } },
      ],
    });
    const warnings = (response.structuredContent as { warnings: string[] }).warnings.join(" ");
    expect(warnings).toContain("pasteData");
  });
});
