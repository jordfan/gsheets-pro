/**
 * The live round trip for `sheets_check` and `sheets_render`.
 *
 * Everything here runs against a real, disposable spreadsheet and needs both a
 * credential and `GSHEETS_PRO_LIVE_SPREADSHEET`. Without them every test skips,
 * so the file is safe in CI. See `vitest.live.config.ts` for the command.
 *
 * Two things can only be settled here. The lint has to survive a real
 * `spreadsheets.get`, whose shape is sparser than any fixture: blocks that start
 * where they like, cells that come back as `{}`, and error values that only
 * appear once Google has actually evaluated the formula. And the render has to
 * survive an undocumented endpoint that no fake can stand in for.
 *
 * The tabs are named with a timestamp so two runs never collide, and deleted at
 * the end. Every name in them is invented.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import fs from "node:fs";

import { getContext, resetContext, type Context } from "../../src/lib/client.js";
import { isFailure, errorOf, type ToolResponse } from "../../src/lib/result.js";
import { hasPdftoppm } from "../../src/lib/render.js";
import { resetRenderMode } from "../../src/lib/rendermode.js";
import { clearWrites, recordWrite } from "../../src/lib/writelog.js";
import { createCheckTool } from "../../src/tools/check.js";
import { createRenderTool } from "../../src/tools/render.js";

const SPREADSHEET_ID = process.env.GSHEETS_PRO_LIVE_SPREADSHEET;
const live = SPREADSHEET_ID ? describe : describe.skip;

const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(8, 14);
const CHECK_TAB = `Check ${stamp}`;
const RENDER_TAB = `Render ${stamp}`;

let ctx: Context;
let check: ReturnType<typeof createCheckTool>;
let render: ReturnType<typeof createRenderTool>;
let poppler = false;

function unwrap(response: ToolResponse): Record<string, unknown> {
  if (isFailure(response)) {
    throw new Error(`tool failed: ${JSON.stringify(errorOf(response))}`);
  }
  return (response.structuredContent ?? {}) as Record<string, unknown>;
}

async function addTab(title: string): Promise<number> {
  const response = await ctx.sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID!,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
  return response.data.replies?.[0]?.addSheet?.properties?.sheetId ?? 0;
}

async function seed(tab: string, rows: unknown[][]): Promise<void> {
  await ctx.sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID!,
    range: `'${tab}'!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  });
}

live("sheets_check and sheets_render, live", () => {
  beforeAll(async () => {
    resetContext();
    resetRenderMode();
    clearWrites();
    ctx = await getContext();
    const deps = { getContext: async () => ctx };
    check = createCheckTool(deps);
    render = createRenderTool(deps);
    poppler = await hasPdftoppm();

    const checkSheetId = await addTab(CHECK_TAB);
    const renderSheetId = await addTab(RENDER_TAB);

    // One tab with a real formula error, a real merge inside the data, no
    // frozen header, a duplicated value, and a line of text that reads as
    // machine output. Everything a fixture asserts, produced by Sheets itself.
    await seed(CHECK_TAB, [
      ["Student", "Teacher", "Sessions", "Fee", "Note"],
      ["Nell Ashgrove", "Bellweather", 16, "=C2*80", "Moved to 3:15."],
      ["Iver Tolman", "Bellweather", 16, "=C3*Rate", "TODO: confirm per 18f2a1c9b4d0e77a"],
      ["Nell Ashgrove", "Scott Ling", 8, "=C4*80", "Second instrument."],
    ]);
    await seed(RENDER_TAB, [
      ["Term", "Class", "Enrolled"],
      ["Fall", "Clay Studio", 12],
      ["Fall", "Chess Club", 9],
    ]);

    await ctx.sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID!,
      requestBody: {
        requests: [
          {
            mergeCells: {
              range: {
                sheetId: checkSheetId,
                startRowIndex: 1,
                endRowIndex: 2,
                startColumnIndex: 0,
                endColumnIndex: 2,
              },
              mergeType: "MERGE_ALL",
            },
          },
          {
            repeatCell: {
              range: { sheetId: checkSheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: { userEnteredFormat: { textFormat: { bold: true } } },
              fields: "userEnteredFormat.textFormat.bold",
            },
          },
          {
            repeatCell: {
              range: { sheetId: renderSheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: {
                userEnteredFormat: {
                  textFormat: { bold: true, foregroundColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } } },
                  backgroundColorStyle: { rgbColor: { red: 0.09, green: 0.44, blue: 0.33 } },
                },
              },
              fields: "userEnteredFormat(textFormat,backgroundColorStyle)",
            },
          },
          {
            updateSheetProperties: {
              properties: { sheetId: renderSheetId, gridProperties: { frozenRowCount: 1 } },
              fields: "gridProperties.frozenRowCount",
            },
          },
        ],
      },
    });
  }, 120_000);

  afterAll(async () => {
    for (const tab of [CHECK_TAB, RENDER_TAB]) {
      try {
        const info = await ctx.cache.resolve(SPREADSHEET_ID!, tab);
        await ctx.sheets.spreadsheets.batchUpdate({
          spreadsheetId: SPREADSHEET_ID!,
          requestBody: { requests: [{ deleteSheet: { sheetId: info.sheetId } }] },
        });
      } catch {
        // A leftover tab on a disposable spreadsheet is not worth failing over.
      }
    }
    clearWrites();
  }, 120_000);

  test("the lint reads a real spreadsheets.get and finds what is there", async () => {
    recordWrite({ spreadsheetId: SPREADSHEET_ID!, range: `'${CHECK_TAB}'!E2:E4`, tool: "sheets_write" });

    const body = unwrap(await check.handler({ spreadsheet_id: SPREADSHEET_ID, sheets: [CHECK_TAB] }));
    const findings = body.findings as Array<{ rule: string; location: string; fix: string }>;
    const rules = new Set(findings.map((f) => f.rule));

    // =C3*Rate has no such named range, so Sheets evaluates it to #NAME?.
    expect(body.status).toBe("errors_found");
    expect(body.total_errors).toBe(1);
    expect(Object.keys(body.error_summary as object)).toEqual(["NAME"]);
    expect(rules.has("L01")).toBe(true);

    // The merge covers the first data row.
    expect(rules.has("L04")).toBe(true);
    // Bold header, no frozen rows.
    expect(rules.has("L09")).toBe(true);

    expect(body.total_formulas).toBeGreaterThanOrEqual(3);
    for (const finding of findings) {
      expect(finding.location.startsWith("'Check") || finding.location.startsWith("Check")).toBe(true);
      expect(finding.fix.length).toBeGreaterThan(20);
    }
  }, 120_000);

  test("a clean tab reports success", async () => {
    const body = unwrap(await check.handler({ spreadsheet_id: SPREADSHEET_ID, sheets: [RENDER_TAB] }));
    expect(body.status).toBe("success");
    expect(body.total_errors).toBe(0);
  }, 120_000);

  test("selecting one rule runs only that rule", async () => {
    const body = unwrap(
      await check.handler({ spreadsheet_id: SPREADSHEET_ID, sheets: [CHECK_TAB], rules: ["L09"] }),
    );
    expect(body.rules_run).toEqual(["L09"]);
    expect((body.findings as Array<{ rule: string }>).every((f) => f.rule === "L09")).toBe(true);
  }, 120_000);

  test("the render produces a PNG that exists and has real dimensions", async () => {
    if (!poppler) {
      // The install line is the useful part when poppler is missing, and the
      // offline suite already asserts it, so this is a skip rather than a fail.
      expect(poppler).toBe(false);
      return;
    }
    const body = unwrap(await render.handler({ spreadsheet_id: SPREADSHEET_ID, sheet: RENDER_TAB }));
    const pages = body.pages as Array<{ path: string }>;

    expect(body.mode).toBe("local");
    expect(pages.length).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(pages[0].path)).toBe(true);
    expect(fs.statSync(pages[0].path).size).toBeGreaterThan(1000);

    const size = body.size as { width: number; height: number };
    expect(size.width).toBeGreaterThan(400);
    expect(body.whole_workbook).toBe(false);

    for (const page of pages) fs.rmSync(page.path, { force: true });
  }, 180_000);

  test("a range renders a different picture than the whole tab", async () => {
    if (!poppler) return;
    const whole = unwrap(await render.handler({ spreadsheet_id: SPREADSHEET_ID, sheet: RENDER_TAB }));
    const part = unwrap(
      await render.handler({ spreadsheet_id: SPREADSHEET_ID, sheet: RENDER_TAB, range: "A1:B2" }),
    );
    const wholePages = whole.pages as Array<{ path: string }>;
    const partPages = part.pages as Array<{ path: string }>;

    expect(part.range).toBe("A1:B2");
    // Not a size comparison. `fitw` scales the content to the page width, so a
    // two column range comes back magnified and is frequently the larger file.
    // What proves the range parameters landed is that the picture changed.
    expect(fs.readFileSync(partPages[0].path).equals(fs.readFileSync(wholePages[0].path))).toBe(false);

    for (const page of [...wholePages, ...partPages]) fs.rmSync(page.path, { force: true });
  }, 180_000);

  test("an unknown tab is refused before anything is fetched", async () => {
    const response = await render.handler({
      spreadsheet_id: SPREADSHEET_ID,
      sheet: `No Such Tab ${stamp}`,
    });
    expect(isFailure(response)).toBe(true);
    expect(errorOf(response)?.code).toBe("sheet_not_found");
  }, 120_000);
});
