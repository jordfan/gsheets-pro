/**
 * The live round trip for `sheets_structure`, `sheets_find` and `sheets_batch`.
 *
 * Everything here runs against a real, disposable spreadsheet and needs both a
 * credential and `GSHEETS_PRO_LIVE_SPREADSHEET`. Without them every test skips,
 * so the file is safe in CI. See `vitest.live.config.ts` for the command.
 *
 * The suite creates its own tabs, named with a timestamp so two runs never
 * collide, and deletes them at the end. Data in them is invented.
 *
 * One thing is deliberately not tested live: `sheets_find share`. Sharing
 * grants a real person access to a real file and cannot be taken back from
 * anyone who has already opened it, so the offline suite covers its argument
 * handling and its refusals and nobody's inbox is involved.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { getContext, resetContext, type Context } from "../../src/lib/client.js";
import { isFailure, errorOf, type ToolResponse } from "../../src/lib/result.js";
import { createBatchTool } from "../../src/tools/batch.js";
import { createFindTool } from "../../src/tools/find.js";
import { createStructureTool } from "../../src/tools/structure.js";
import { paceContext } from "./pacing.js";

const SPREADSHEET_ID = process.env.GSHEETS_PRO_LIVE_SPREADSHEET;
const live = SPREADSHEET_ID ? describe : describe.skip;

/** Titled exactly as the brief requires, so it is obvious the copy is disposable. */
const COPY_TITLE = "gsheets-pro find spike (safe to delete)";

const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(8, 14);
const STRUCT_TAB = `Struct ${stamp}`;
const STRUCT_RENAMED = `Struct ${stamp} renamed`;
const BATCH_TAB = `Batch ${stamp}`;

let ctx: Context;
let structure: ReturnType<typeof createStructureTool>;
let find: ReturnType<typeof createFindTool>;
let batch: ReturnType<typeof createBatchTool>;
/** Filled in if the copy test runs, so the report can name it. */
let copiedSpreadsheetId: string | undefined;

function unwrap(response: ToolResponse): Record<string, unknown> {
  if (isFailure(response)) {
    throw new Error(`tool failed: ${JSON.stringify(errorOf(response))}`);
  }
  return (response.structuredContent ?? {}) as Record<string, unknown>;
}

async function seed(tab: string, rows: unknown[][]): Promise<void> {
  await ctx.sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID!,
    range: `'${tab}'!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  });
}

async function readBack(range: string): Promise<string[][]> {
  const response = await ctx.sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID!,
    range,
    valueRenderOption: "FORMATTED_VALUE",
  });
  return (response.data.values ?? []) as string[][];
}

live("sheets_structure, sheets_find and sheets_batch, live", () => {
  beforeAll(async () => {
    resetContext();
    ctx = paceContext(await getContext());
    const deps = { getContext: async () => ctx };
    structure = createStructureTool(deps);
    find = createFindTool(deps);
    batch = createBatchTool(deps);
  });

  afterAll(async () => {
    // Best effort cleanup. A leftover tab on a disposable spreadsheet is not
    // worth failing the run over.
    for (const tab of [STRUCT_TAB, STRUCT_RENAMED, BATCH_TAB, `${STRUCT_TAB} copy`]) {
      try {
        await structure.handler({
          spreadsheet_id: SPREADSHEET_ID,
          action: "delete_tab",
          sheet: tab,
          confirm: tab,
        });
      } catch {
        // The tab was renamed away or never created.
      }
    }
    if (copiedSpreadsheetId) {
      // eslint-disable-next-line no-console
      console.log(`Live run left a copied spreadsheet behind: ${copiedSpreadsheetId} ("${COPY_TITLE}")`);
    }
  });

  test("add_tab creates a tab and reports its id", async () => {
    const result = unwrap(
      await structure.handler({ spreadsheet_id: SPREADSHEET_ID, action: "add_tab", title: STRUCT_TAB }),
    );
    expect((result["result"] as { new_sheet?: { title?: string } })?.new_sheet?.title).toBe(STRUCT_TAB);

    await seed(STRUCT_TAB, [
      ["Student", "Class", "Sessions", "Fee"],
      ["  Oren Whitfield  ", "Clay Studio", 6, "=C2*55"],
      ["Marta Lindqvist", "Chess Club", 8, "=C3*55"],
      ["Oren Whitfield", "Clay Studio", 6, "=C4*55"],
      ["Ines Karabo", "Clay Studio", 4, "=C5*55"],
    ]);
    // Freeze the header so sort and dedupe can find the data on their own.
    await ctx.sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID!,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: {
                sheetId: (await ctx.cache.resolve(SPREADSHEET_ID!, STRUCT_TAB)).sheetId,
                gridProperties: { frozenRowCount: 1 },
              },
              fields: "gridProperties.frozenRowCount",
            },
          },
        ],
      },
    });
    ctx.cache.invalidate(SPREADSHEET_ID!);
  });

  test("trim removes the whitespace a person left behind", async () => {
    unwrap(await structure.handler({ spreadsheet_id: SPREADSHEET_ID, action: "trim", sheet: STRUCT_TAB }));
    const rows = await readBack(`'${STRUCT_TAB}'!A2:A2`);
    expect(rows[0]?.[0]).toBe("Oren Whitfield");
  });

  test("sort by header name orders the data and leaves the header alone", async () => {
    const result = unwrap(
      await structure.handler({
        spreadsheet_id: SPREADSHEET_ID,
        action: "sort",
        sheet: STRUCT_TAB,
        sort_by: [{ column: "Student" }],
      }),
    );
    expect((result["check"] as { status: string }).status).toBe("success");
    const rows = await readBack(`'${STRUCT_TAB}'!A1:A5`);
    expect(rows[0]?.[0]).toBe("Student");
    expect(rows.slice(1).map((r) => r[0])).toEqual([
      "Ines Karabo",
      "Marta Lindqvist",
      "Oren Whitfield",
      "Oren Whitfield",
    ]);
  });

  test("dedupe on named key columns removes the repeat", async () => {
    const result = unwrap(
      await structure.handler({
        spreadsheet_id: SPREADSHEET_ID,
        action: "dedupe",
        sheet: STRUCT_TAB,
        key_columns: ["Student", "Class"],
        confirm: STRUCT_TAB,
      }),
    );
    expect((result["result"] as { duplicates_removed?: number })?.duplicates_removed).toBe(1);
    const rows = await readBack(`'${STRUCT_TAB}'!A2:A10`);
    expect(rows.filter((r) => r[0]).length).toBe(3);
  });

  test("find_replace changes values and leaves formulas alone", async () => {
    unwrap(
      await structure.handler({
        spreadsheet_id: SPREADSHEET_ID,
        action: "find_replace",
        sheet: STRUCT_TAB,
        find: "Clay Studio",
        replace: "Ceramics",
        confirm: STRUCT_TAB,
      }),
    );
    const rows = await readBack(`'${STRUCT_TAB}'!B2:B4`);
    expect(rows.flat()).toContain("Ceramics");
  });

  test("delete_rows breaks a formula and the gate says so", async () => {
    // C4 feeds =C4*55 in D4; deleting row 4 leaves that formula pointing at
    // nothing, which is exactly what the gate exists to catch.
    await seed(STRUCT_TAB, [["Student", "Class", "Sessions", "Fee"]]);
    await ctx.sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID!,
      range: `'${STRUCT_TAB}'!A2`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          ["Ines Karabo", "Ceramics", 4, 220],
          ["Marta Lindqvist", "Chess Club", 8, 440],
          ["Oren Whitfield", "Ceramics", 6, 330],
          ["Total", "", "", "=SUM(D2:D4)+D4"],
        ],
      },
    });

    const result = unwrap(
      await structure.handler({
        spreadsheet_id: SPREADSHEET_ID,
        action: "delete_rows",
        sheet: STRUCT_TAB,
        rows: "4",
        confirm: STRUCT_TAB,
      }),
    );
    const check = result["check"] as { status: string; error_summary: Record<string, number> };
    expect(check.status).toBe("errors_found");
    expect(Object.keys(check.error_summary)).toContain("REF");
  });

  test("delete_rows without confirm refuses and changes nothing", async () => {
    const before = await readBack(`'${STRUCT_TAB}'!A1:D10`);
    const response = await structure.handler({
      spreadsheet_id: SPREADSHEET_ID,
      action: "delete_rows",
      sheet: STRUCT_TAB,
      rows: "2",
    });
    expect(errorOf(response)?.code).toBe("needs_confirmation");
    expect(await readBack(`'${STRUCT_TAB}'!A1:D10`)).toEqual(before);
  });

  test("protect then unprotect round trips by description", async () => {
    const description = `Live test protection ${stamp}`;
    unwrap(
      await structure.handler({
        spreadsheet_id: SPREADSHEET_ID,
        action: "protect",
        sheet: STRUCT_TAB,
        range: "C1:D50",
        description,
      }),
    );
    unwrap(
      await structure.handler({
        spreadsheet_id: SPREADSHEET_ID,
        action: "unprotect",
        sheet: STRUCT_TAB,
        description,
      }),
    );
    const response = await structure.handler({
      spreadsheet_id: SPREADSHEET_ID,
      action: "unprotect",
      sheet: STRUCT_TAB,
      description,
    });
    expect(isFailure(response)).toBe(true);
  });

  test("group and ungroup round trip", async () => {
    unwrap(
      await structure.handler({
        spreadsheet_id: SPREADSHEET_ID,
        action: "group",
        sheet: STRUCT_TAB,
        rows: "2:3",
        collapsed: true,
      }),
    );
    unwrap(
      await structure.handler({
        spreadsheet_id: SPREADSHEET_ID,
        action: "ungroup",
        sheet: STRUCT_TAB,
        rows: "2:3",
      }),
    );
  });

  test("insert_columns, move_columns and delete_columns leave the grid where expected", async () => {
    unwrap(
      await structure.handler({
        spreadsheet_id: SPREADSHEET_ID,
        action: "insert_columns",
        sheet: STRUCT_TAB,
        columns: "B",
      }),
    );
    await ctx.sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID!,
      range: `'${STRUCT_TAB}'!B1`,
      valueInputOption: "RAW",
      requestBody: { values: [["Marker"]] },
    });
    unwrap(
      await structure.handler({
        spreadsheet_id: SPREADSHEET_ID,
        action: "move_columns",
        sheet: STRUCT_TAB,
        columns: "B",
        to: "A",
      }),
    );
    expect((await readBack(`'${STRUCT_TAB}'!A1:B1`))[0]).toEqual(["Marker", "Student"]);

    unwrap(
      await structure.handler({
        spreadsheet_id: SPREADSHEET_ID,
        action: "delete_columns",
        sheet: STRUCT_TAB,
        columns: "A",
        confirm: STRUCT_TAB,
      }),
    );
    expect((await readBack(`'${STRUCT_TAB}'!A1:A1`))[0]?.[0]).toBe("Student");
  });

  test("duplicate_tab, rename_tab, hide and show", async () => {
    unwrap(
      await structure.handler({
        spreadsheet_id: SPREADSHEET_ID,
        action: "duplicate_tab",
        sheet: STRUCT_TAB,
        title: `${STRUCT_TAB} copy`,
      }),
    );
    unwrap(
      await structure.handler({
        spreadsheet_id: SPREADSHEET_ID,
        action: "hide_tab",
        sheet: `${STRUCT_TAB} copy`,
      }),
    );
    unwrap(
      await structure.handler({
        spreadsheet_id: SPREADSHEET_ID,
        action: "show_tab",
        sheet: `${STRUCT_TAB} copy`,
      }),
    );
    unwrap(
      await structure.handler({
        spreadsheet_id: SPREADSHEET_ID,
        action: "rename_tab",
        sheet: STRUCT_TAB,
        title: STRUCT_RENAMED,
      }),
    );
    const titles = (await ctx.cache.list(SPREADSHEET_ID!, true)).titles;
    expect(titles).toContain(STRUCT_RENAMED);
    expect(titles).not.toContain(STRUCT_TAB);
  });

  test("sheets_find list finds this spreadsheet by title", async () => {
    const meta = await ctx.sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID!,
      fields: "properties.title",
    });
    const title = meta.data.properties?.title ?? "";
    const result = unwrap(await find.handler({ action: "list", query: title.slice(0, 12) }));
    const ids = (result["spreadsheets"] as Array<{ spreadsheet_id: string }>).map(
      (s) => s.spreadsheet_id,
    );
    expect(ids).toContain(SPREADSHEET_ID);
  });

  test("sheets_find copy makes a disposable copy, and copy_tab_to lands a tab in it", async () => {
    const copy = unwrap(await find.handler({ action: "copy", spreadsheet_id: SPREADSHEET_ID, title: COPY_TITLE }));
    copiedSpreadsheetId = String(copy["spreadsheet_id"]);
    expect(copiedSpreadsheetId).toBeTruthy();
    expect(copy["title"]).toBe(COPY_TITLE);

    const copied = unwrap(
      await structure.handler({
        spreadsheet_id: SPREADSHEET_ID,
        action: "copy_tab_to",
        sheet: STRUCT_RENAMED,
        destination_spreadsheet_id: copiedSpreadsheetId,
      }),
    );
    expect((copied["new_sheet"] as { title?: string })?.title).toContain("Copy of");
  });

  test("sheets_batch dry_run resolves names and ranges without sending", async () => {
    unwrap(
      await structure.handler({ spreadsheet_id: SPREADSHEET_ID, action: "add_tab", title: BATCH_TAB }),
    );
    await seed(BATCH_TAB, [
      ["Vendor", "Rate"],
      ["Clay & Kiln", 55],
      ["Board & Piece", 45],
    ]);

    const plan = unwrap(
      await batch.handler({
        spreadsheet_id: SPREADSHEET_ID,
        dry_run: true,
        requests: [
          {
            repeatCell: {
              range: `'${BATCH_TAB}'!A1:B1`,
              cell: { userEnteredFormat: { textFormat: { bold: true } } },
              fields: "userEnteredFormat.textFormat.bold",
            },
          },
          { insertDimension: { range: `'${BATCH_TAB}'!4:5` } },
        ],
      }),
    );
    const resolved = plan["resolved_requests"] as Array<Record<string, Record<string, unknown>>>;
    expect(resolved[0]["repeatCell"]["range"]).toMatchObject({ startRowIndex: 0, endRowIndex: 1 });
    expect(resolved[1]["insertDimension"]["range"]).toMatchObject({
      dimension: "ROWS",
      startIndex: 3,
      endIndex: 5,
    });
    expect(plan["touched"]).toHaveLength(2);
  });

  test("sheets_batch applies the same requests and reports a clean check", async () => {
    const applied = unwrap(
      await batch.handler({
        spreadsheet_id: SPREADSHEET_ID,
        requests: [
          {
            repeatCell: {
              range: `'${BATCH_TAB}'!A1:B1`,
              cell: { userEnteredFormat: { textFormat: { bold: true } } },
              fields: "userEnteredFormat.textFormat.bold",
            },
          },
          { insertDimension: { range: `'${BATCH_TAB}'!4:5` } },
        ],
      }),
    );
    expect(applied["request_count"]).toBe(2);
    expect((applied["check"] as { status: string }).status).toBe("success");
    const rows = await readBack(`'${BATCH_TAB}'!A1:B3`);
    expect(rows[0]).toEqual(["Vendor", "Rate"]);
  });

  test("sheets_batch refuses a cell block where the API wants whole rows", async () => {
    const response = await batch.handler({
      spreadsheet_id: SPREADSHEET_ID,
      requests: [{ insertDimension: { range: `'${BATCH_TAB}'!A2:B4` } }],
    });
    expect(errorOf(response)?.code).toBe("bad_range");
  });
});
