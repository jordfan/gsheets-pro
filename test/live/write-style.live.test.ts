/**
 * `sheets_write` and `sheets_style` against the real Sheets API.
 *
 * Gated on `GSHEETS_PRO_LIVE_SPREADSHEET` and a working credential, so
 * `npm test` never reaches it. Everything it does is confined to two tabs it
 * creates and resets itself, `Write Live` and `Style Live`, and every name in
 * the data is invented.
 *
 * Run it with:
 *
 *   GSHEETS_PRO_LIVE_SPREADSHEET=<id> \
 *   GSHEETS_PRO_TOKEN_FILE=... GSHEETS_PRO_OAUTH_CLIENT=... \
 *   npm run test:live
 *
 * It deliberately does NOT write a spreadsheet theme, because the theme is
 * workbook-wide and the disposable spreadsheet holds other people's tabs. The
 * theme path is exercised with `dry_run`, which sends nothing, and by the
 * offline suite.
 */
import { beforeAll, beforeEach, describe, expect, test } from "vitest";

import { withRetry } from "../../src/lib/batch.js";
import { getContext, type Context } from "../../src/lib/client.js";
import { isFailure, errorOf, type ToolResponse } from "../../src/lib/result.js";
import { createStyleTool } from "../../src/tools/style.js";
import { createWriteTool } from "../../src/tools/write.js";

const SPREADSHEET = process.env.GSHEETS_PRO_LIVE_SPREADSHEET;
const WRITE_TAB = "Write Live";
const STYLE_TAB = "Style Live";

const suite = SPREADSHEET ? describe : describe.skip;

/**
 * Sheets allows sixty reads a minute per user and each case here spends
 * several: three or four inside the tool, one or two more to read the result
 * back. Without a pause the suite crosses that line partway through, and the
 * failures then read as tool bugs rather than as quota, which cost an hour
 * once already. Leave a minute between runs for the same reason.
 */
const QUOTA_PAUSE_MS = 3_000;

let context: Context;
let write: (args: Record<string, unknown>) => Promise<ToolResponse>;
let style: (args: Record<string, unknown>) => Promise<ToolResponse>;

/**
 * Delete every tab this suite owns, then make them fresh.
 *
 * The tabs are left behind when the run ends, on purpose: when a case fails,
 * the sheet itself is the evidence, and the next run resets them anyway.
 */
async function resetTabs(): Promise<void> {
  const existing = await context.sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET!,
    fields: "sheets.properties(sheetId,title)",
  });
  const deletes = (existing.data.sheets ?? [])
    .filter((s) => s.properties?.title === WRITE_TAB || s.properties?.title === STYLE_TAB)
    .map((s) => ({ deleteSheet: { sheetId: s.properties!.sheetId } }));
  if (deletes.length) {
    await context.sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET!,
      requestBody: { requests: deletes },
    });
  }

  const created = await context.sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET!,
    requestBody: {
      requests: [
        { addSheet: { properties: { title: WRITE_TAB, gridProperties: { frozenRowCount: 1 } } } },
        { addSheet: { properties: { title: STYLE_TAB, gridProperties: { frozenRowCount: 1 } } } },
      ],
    },
  });
  void created;
  context.cache.invalidate(SPREADSHEET!);

  // A small roster with one real formula column, which is what the formula
  // guard has to notice.
  const seed = [
    ["Student", "Grade", "Club", "Sessions", "Fee"],
    ["Ana Reyes", "3", "Clay Studio", "8", "=D2*55"],
    ["Bo Tran", "4", "Chess Club", "8", "=D3*55"],
    ["Cy Okafor", "5", "Clay Studio", "6", "=D4*55"],
  ];
  await context.sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET!,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        { range: `'${WRITE_TAB}'!A1:E4`, values: seed },
        { range: `'${STYLE_TAB}'!A1:E4`, values: seed },
      ],
    },
  });
}

beforeAll(async () => {
  if (!SPREADSHEET) return;
  context = await getContext();
  write = createWriteTool({ getContext: async () => context }).handler;
  style = createStyleTool({ getContext: async () => context }).handler;
  await resetTabs();
}, 120_000);

beforeEach(async () => {
  if (!SPREADSHEET) return;
  await new Promise((resolve) => setTimeout(resolve, QUOTA_PAUSE_MS));
});

const base = () => ({ spreadsheet_id: SPREADSHEET!, sheet: WRITE_TAB });

/**
 * The tools back off on a 429 by themselves; the assertions have to as well,
 * or a quota blip surfaces as a failed expectation with no hint of its cause.
 */
async function readBack(range: string, render = "FORMATTED_VALUE"): Promise<unknown[][]> {
  const response = await withRetry(() =>
    context.sheets.spreadsheets.values.batchGet({
      spreadsheetId: SPREADSHEET!,
      ranges: [range],
      valueRenderOption: render as never,
    }),
  );
  return (response.data.valueRanges?.[0]?.values ?? []) as unknown[][];
}

suite("sheets_write, live", () => {
  test("a range write lands and the gate reads it back clean", async () => {
    const response = await write({ ...base(), range: "B2:B4", values: [["4"], ["5"], ["6"]] });
    expect(isFailure(response)).toBe(false);

    const check = (response.structuredContent as { check: { status: string; total_formulas: number } })
      .check;
    expect(check.status).toBe("ok");

    const values = await readBack(`'${WRITE_TAB}'!B2:B4`);
    expect(values.map((r) => String(r[0]))).toEqual(["4", "5", "6"]);
  });

  test("the formula guard refuses the real formula column", async () => {
    const response = await write({ ...base(), range: "E2:E4", values: [["1"], ["2"], ["3"]] });
    expect(errorOf(response)?.code).toBe("formula_guard");
    expect(errorOf(response)?.message).toContain("=D2*55");

    const formulas = await readBack(`'${WRITE_TAB}'!E2`, "FORMULA");
    expect(String(formulas[0][0])).toBe("=D2*55");
  });

  test("append lands straight after the last row of data", async () => {
    const response = await write({
      ...base(),
      mode: "append",
      records: [{ Student: "Della Marsh", Grade: "3", Club: "Chess Club", Sessions: "8" }],
    });
    expect(isFailure(response)).toBe(false);

    const values = await readBack(`'${WRITE_TAB}'!A5:D5`);
    expect(values[0][0]).toBe("Della Marsh");
    expect(values[0][3]).toBe("8");
  });

  test("the batch upsert matches on the key and appends the rest, in one write", async () => {
    const response = await write({
      ...base(),
      mode: "upsert",
      key_column: "Student",
      rows: [
        { key: "Ana Reyes", set: { Club: "Chess Club" } },
        { key: "Ely Nunes", set: { Grade: "4", Club: "Clay Studio", Sessions: "6" } },
      ],
    });
    expect(isFailure(response)).toBe(false);

    const structured = response.structuredContent as {
      matched: number;
      inserted: number;
      api_calls: string[];
    };
    expect(structured.matched).toBe(1);
    expect(structured.inserted).toBe(1);
    expect(structured.api_calls.filter((c) => c.startsWith("values.batchUpdate"))).toHaveLength(1);

    const values = await readBack(`'${WRITE_TAB}'!A2:C6`);
    expect(values[0][2]).toBe("Chess Club");
    expect(values.some((row) => row[0] === "Ely Nunes")).toBe(true);
  });

  test("fill adjusts the references row by row", async () => {
    const response = await write({
      ...base(),
      mode: "fill",
      range: "F2:F5",
      formula: "=D2*10",
    });
    expect(isFailure(response)).toBe(false);

    const formulas = await readBack(`'${WRITE_TAB}'!F2:F5`, "FORMULA");
    expect(String(formulas[0][0])).toBe("=D2*10");
    expect(String(formulas[1][0])).toBe("=D3*10");
    expect(String(formulas[3][0])).toBe("=D5*10");
  });

  test("the gate finds a real error the sheet was given", async () => {
    await write({ ...base(), range: "G2", values: [["=1/0"]] });
    const response = await write({ ...base(), range: "H2", values: [["x"]] });
    expect(isFailure(response)).toBe(false);

    // H2 alone is clean; the gate only reads what this call wrote.
    const clean = (response.structuredContent as { check: { status: string } }).check;
    expect(clean.status).toBe("ok");

    const overlapping = await write({ ...base(), range: "G2", values: [["=1/0"]] });
    const check = (overlapping.structuredContent as { check: { status: string; error_summary: Record<string, number> } })
      .check;
    expect(check.status).toBe("errors_found");
    expect(Object.keys(check.error_summary)).toContain("DIVIDE_BY_ZERO");
  });

  test("dry_run changes nothing on the real sheet", async () => {
    const before = await readBack(`'${WRITE_TAB}'!C2`);
    const response = await write({
      ...base(),
      range: "C2",
      values: [["Should not land"]],
      dry_run: true,
    });
    expect((response.structuredContent as { dry_run: boolean }).dry_run).toBe(true);
    const after = await readBack(`'${WRITE_TAB}'!C2`);
    expect(after).toEqual(before);
  });

  test("a pasted URL opens the same spreadsheet", async () => {
    const response = await write({
      ...base(),
      spreadsheet_id: `https://docs.google.com/spreadsheets/d/${SPREADSHEET}/edit#gid=0`,
      range: "B2",
      values: [["4"]],
    });
    expect(isFailure(response)).toBe(false);
  });
});

suite("sheets_style, live", () => {
  const styleBase = () => ({ spreadsheet_id: SPREADSHEET!, sheet: STYLE_TAB });

  test("a header role paints a theme reference the API keeps", async () => {
    const response = await style({
      ...styleBase(),
      range: "A1:E1",
      preset: "park",
      style: { role: "header" },
    });
    expect(isFailure(response)).toBe(false);

    const read = await context.sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET!,
      ranges: [`'${STYLE_TAB}'!A1`],
      includeGridData: true,
      fields:
        "sheets.data.rowData.values.userEnteredFormat(backgroundColorStyle,textFormat(bold,foregroundColorStyle))",
    });
    const format = read.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values?.[0]?.userEnteredFormat;
    expect(format?.backgroundColorStyle?.themeColor).toBe("ACCENT1");
    expect(format?.textFormat?.bold).toBe(true);
  });

  test("banding is added, then updated rather than added twice", async () => {
    const first = await style({ ...styleBase(), range: "A1:E6", preset: "park", banding: {} });
    expect(isFailure(first)).toBe(false);
    expect((first.structuredContent as { actions: string[] }).actions.join(" ")).toContain("banded");

    const second = await style({
      ...styleBase(),
      range: "A1:E6",
      preset: "park",
      banding: { second: "#EAF2EE" },
    });
    expect(isFailure(second)).toBe(false);
    expect((second.structuredContent as { actions: string[] }).actions.join(" ")).toContain(
      "updated the banding",
    );

    const read = await context.sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET!,
      fields: "sheets(properties(title),bandedRanges(bandedRangeId))",
    });
    const tab = read.data.sheets?.find((s) => s.properties?.title === STYLE_TAB);
    expect(tab?.bandedRanges).toHaveLength(1);
  });

  test("freeze, gridlines, widths and borders all land in one batchUpdate", async () => {
    const response = await style({
      ...styleBase(),
      range: "A1:E1",
      freeze_rows: 1,
      gridlines: false,
      column_widths: [{ columns: "A:E", pixels: 130 }],
      borders: { edges: "outer" },
      tab_color: "theme:ACCENT2",
    });
    expect(isFailure(response)).toBe(false);
    // One updateSheetProperties carrying the freeze, the gridlines and the tab
    // color, one updateDimensionProperties, one updateBorders.
    expect((response.structuredContent as { request_count: number }).request_count).toBe(3);

    const read = await context.sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET!,
      fields: "sheets.properties(title,gridProperties(frozenRowCount,hideGridlines),tabColorStyle)",
    });
    const properties = read.data.sheets?.find((s) => s.properties?.title === STYLE_TAB)?.properties;
    expect(properties?.gridProperties?.frozenRowCount).toBe(1);
    expect(properties?.gridProperties?.hideGridlines).toBe(true);
    expect(properties?.tabColorStyle?.themeColor).toBe("ACCENT2");
  });

  test("a merge in the data region is refused and nothing is sent", async () => {
    const response = await style({ ...styleBase(), merge: { range: "A2:C2" } });
    expect(errorOf(response)?.code).toBe("contract_violation");

    const read = await context.sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET!,
      fields: "sheets(properties(title),merges)",
    });
    const tab = read.data.sheets?.find((s) => s.properties?.title === STYLE_TAB);
    expect(tab?.merges ?? []).toHaveLength(0);
  });

  test("clear takes the banding and the formatting off together", async () => {
    const response = await style({
      ...styleBase(),
      range: "A1:E6",
      clear: { formats: true, banding: true, merges: true },
    });
    expect(isFailure(response)).toBe(false);

    const read = await context.sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET!,
      ranges: [`'${STYLE_TAB}'!A1`],
      includeGridData: true,
      fields:
        "sheets(properties(title),bandedRanges(bandedRangeId),data.rowData.values.userEnteredFormat(backgroundColorStyle))",
    });
    const tab = read.data.sheets?.[0];
    expect(tab?.bandedRanges ?? []).toHaveLength(0);
    const format = tab?.data?.[0]?.rowData?.[0]?.values?.[0]?.userEnteredFormat;
    expect(format?.backgroundColorStyle?.themeColor).toBeUndefined();
  });

  test("the theme write is only exercised as a dry run, because a theme is workbook wide", async () => {
    const response = await style({ spreadsheet_id: SPREADSHEET!, preset: "park", dry_run: true });
    expect(isFailure(response)).toBe(false);

    const requests = (response.structuredContent as { requests: Array<Record<string, unknown>> })
      .requests;
    const theme = requests.find((r) => "updateSpreadsheetProperties" in r) as
      | { updateSpreadsheetProperties: { properties: { spreadsheetTheme: { themeColors: unknown[] } } } }
      | undefined;
    expect(theme?.updateSpreadsheetProperties.properties.spreadsheetTheme.themeColors).toHaveLength(9);
    expect(JSON.stringify(requests)).not.toContain("footerColorStyle");
  });
});
