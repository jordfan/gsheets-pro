/**
 * `sheets_style`.
 *
 * Three things here are worth more than the rest. Everything lands in one
 * batchUpdate. `footerColorStyle` never appears in any request this tool can
 * be made to send, whatever the arguments. And restyling somebody else's
 * spreadsheet is refused rather than done politely.
 *
 * Every name and id in here is invented.
 */
import { describe, expect, test } from "vitest";

import { errorOf, isFailure } from "../src/lib/result.js";
import { createStyleTool } from "../src/tools/style.js";
import {
  batchUpdateJson,
  makeWriteContext,
  requestsOfKind,
  WRITE_SPREADSHEET_ID,
  type WriteSpreadsheetSpec,
} from "./helpers/fakeWriteContext.js";

const SHEET: WriteSpreadsheetSpec = {
  title: "Autumn Clubs",
  tabs: [
    {
      title: "Roster",
      sheetId: 0,
      frozenRowCount: 1,
      values: [
        ["Student", "Grade", "Club"],
        ["Ana Reyes", "3", "Clay Studio"],
        ["Bo Tran", "4", "Chess Club"],
      ],
    },
  ],
  theme: {
    primaryFontFamily: "Arial",
    themeColors: [
      { colorType: "ACCENT6", color: { rgbColor: { red: 0.6, green: 0.3, blue: 0.2 } } },
    ],
  },
};

const SHARED_REGISTRY = JSON.stringify({
  spreadsheets: {
    [WRITE_SPREADSHEET_ID]: { name: "Autumn Clubs", owner: "shared" },
  },
});

function tool(spec: WriteSpreadsheetSpec = SHEET, registry?: string) {
  const fake = makeWriteContext(structuredClone(spec), registry);
  const definition = createStyleTool({ getContext: async () => fake.context });
  return { ...fake, run: definition.handler };
}

const base = { spreadsheet_id: WRITE_SPREADSHEET_ID, sheet: "Roster" };

describe("applying a preset theme", () => {
  test("writes all nine slots and records the preset in metadata", async () => {
    const { run, calls } = tool();
    const response = await run({ spreadsheet_id: WRITE_SPREADSHEET_ID, preset: "park" });

    expect(isFailure(response)).toBe(false);
    expect(calls.batchUpdate).toHaveLength(1);

    const theme = requestsOfKind(calls, "updateSpreadsheetProperties")[0] as {
      properties: { spreadsheetTheme: { themeColors: unknown[]; primaryFontFamily: string } };
      fields: string;
    };
    expect(theme.properties.spreadsheetTheme.themeColors).toHaveLength(9);
    expect(theme.properties.spreadsheetTheme.primaryFontFamily).toBe("Open Sans");
    expect(theme.fields).toBe("spreadsheetTheme");

    const metadata = requestsOfKind(calls, "createDeveloperMetadata");
    const manifest = metadata.find(
      (m) => (m["developerMetadata"] as { metadataKey: string }).metadataKey === "gsheets.manifest",
    );
    expect(manifest).toBeDefined();
    const value = JSON.parse(
      (manifest!["developerMetadata"] as { metadataValue: string }).metadataValue,
    );
    expect(value).toMatchObject({ preset: "park", archetype: "tracker" });
    expect((manifest!["developerMetadata"] as { visibility: string }).visibility).toBe("PROJECT");
  });

  test("an existing manifest is updated rather than duplicated", async () => {
    const withManifest = structuredClone(SHEET);
    const { run, calls } = tool({
      ...withManifest,
      developerMetadata: [
        {
          metadataKey: "gsheets.manifest",
          metadataValue: JSON.stringify({ preset: "neutral" }),
          location: {},
        },
      ],
    });
    await run({ spreadsheet_id: WRITE_SPREADSHEET_ID, preset: "park" });

    expect(requestsOfKind(calls, "updateDeveloperMetadata")).toHaveLength(1);
    const created = requestsOfKind(calls, "createDeveloperMetadata").filter(
      (m) => (m["developerMetadata"] as { metadataKey: string }).metadataKey === "gsheets.manifest",
    );
    expect(created).toHaveLength(0);
  });

  test("an unknown preset names the ones that exist", async () => {
    const { run } = tool();
    const response = await run({ spreadsheet_id: WRITE_SPREADSHEET_ID, preset: "burgundy" });
    expect(errorOf(response)?.hint).toContain("neutral");
  });

  test("nothing to do at all is a refusal that lists what this tool takes", async () => {
    const { run } = tool();
    const response = await run({ ...base });
    expect(errorOf(response)?.message).toContain("nothing to do");
  });
});

describe("styling a range", () => {
  test("a role resolves to a theme reference, not to hex", async () => {
    const { run, calls } = tool();
    await run({ ...base, range: "A1:C1", preset: "park", style: { role: "header" } });

    const repeat = requestsOfKind(calls, "repeatCell")[0] as {
      cell: { userEnteredFormat: Record<string, unknown> };
      fields: string;
    };
    expect(repeat.cell.userEnteredFormat.backgroundColorStyle).toEqual({ themeColor: "ACCENT1" });
    expect(repeat.fields).toContain("userEnteredFormat.backgroundColorStyle");
    expect(repeat.fields).toContain("userEnteredFormat.textFormat.bold");
  });

  test("the field mask names only what was passed, so nothing else is wiped", async () => {
    const { run, calls } = tool();
    await run({ ...base, range: "B2:B3", style: { bold: true } });

    const repeat = requestsOfKind(calls, "repeatCell")[0] as { fields: string };
    expect(repeat.fields).toBe("userEnteredFormat.textFormat.bold");
    expect(repeat.fields).not.toContain("numberFormat");
    expect(repeat.fields).not.toContain("backgroundColorStyle");
  });

  test("a preset number format key beats the generic shorthand", async () => {
    const { run, calls } = tool();
    await run({ ...base, range: "C2:C3", preset: "park", style: { number_format: "currency" } });

    const repeat = requestsOfKind(calls, "repeatCell")[0] as {
      cell: { userEnteredFormat: { numberFormat: { pattern: string } } };
    };
    expect(repeat.cell.userEnteredFormat.numberFormat.pattern).toBe('"$"#,##0;("$"#,##0);"-"');
  });

  test("an explicit theme slot is honoured", async () => {
    const { run, calls } = tool();
    await run({ ...base, range: "A1", style: { background: "theme:ACCENT4" } });
    const repeat = requestsOfKind(calls, "repeatCell")[0] as {
      cell: { userEnteredFormat: { backgroundColorStyle: unknown } };
    };
    expect(repeat.cell.userEnteredFormat.backgroundColorStyle).toEqual({ themeColor: "ACCENT4" });
  });

  test("a note rides along with the style", async () => {
    const { run, calls } = tool();
    await run({ ...base, range: "D1", style: { note: "Fee is the vendor rate times two." } });
    const repeat = requestsOfKind(calls, "repeatCell")[0] as { cell: { note: string }; fields: string };
    expect(repeat.cell.note).toContain("vendor rate");
    expect(repeat.fields).toContain("note");
  });

  test("an empty style object is refused rather than sent", async () => {
    const { run } = tool();
    const response = await run({ ...base, range: "A1", style: {} });
    expect(errorOf(response)?.message).toContain("nothing in it");
  });

  test("asking a tracker for the input font color is refused with the reason", async () => {
    const { run } = tool();
    const response = await run({ ...base, range: "B2", preset: "park", style: { role: "input" } });
    expect(errorOf(response)?.message).toContain("model archetype");
  });

  test("the same call on a model goes through", async () => {
    const { run, calls } = tool();
    const response = await run({
      ...base,
      range: "B2",
      preset: "park",
      archetype: "model",
      style: { role: "input" },
    });
    expect(isFailure(response)).toBe(false);
    const repeat = requestsOfKind(calls, "repeatCell")[0] as {
      cell: { userEnteredFormat: { textFormat: { foregroundColorStyle: unknown } } };
    };
    expect(repeat.cell.userEnteredFormat.textFormat.foregroundColorStyle).toBeDefined();
  });
});

describe("banding", () => {
  test("an unbanded range gets addBanding, with no footer color anywhere", async () => {
    const { run, calls } = tool();
    await run({ ...base, range: "A1:C3", preset: "park", banding: {} });

    const added = requestsOfKind(calls, "addBanding")[0] as {
      bandedRange: { rowProperties: Record<string, unknown> };
    };
    expect(Object.keys(added.bandedRange.rowProperties)).toEqual(
      expect.arrayContaining(["firstBandColorStyle", "secondBandColorStyle"]),
    );
    expect(batchUpdateJson(calls)).not.toContain("footerColorStyle");
  });

  test("a range already banded is updated, because a second banding is refused by the API", async () => {
    const banded = structuredClone(SHEET);
    banded.tabs[0].bandedRanges = [
      {
        bandedRangeId: 77,
        range: { sheetId: 0, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 3 },
      },
    ];
    const { run, calls } = tool(banded);
    await run({ ...base, range: "A1:C3", preset: "park", banding: {} });

    expect(requestsOfKind(calls, "addBanding")).toHaveLength(0);
    const updated = requestsOfKind(calls, "updateBanding")[0] as {
      bandedRange: { bandedRangeId: number };
      fields: string;
    };
    expect(updated.bandedRange.bandedRangeId).toBe(77);
    expect(updated.fields).toContain("rowProperties");
  });

  test("remove deletes the banding that covers the range", async () => {
    const banded = structuredClone(SHEET);
    banded.tabs[0].bandedRanges = [{ bandedRangeId: 77, range: { sheetId: 0 } }];
    const { run, calls } = tool(banded);
    await run({ ...base, range: "A1:C3", banding: { remove: true } });
    expect(requestsOfKind(calls, "deleteBanding")[0]).toEqual({ bandedRangeId: 77 });
  });

  test("banding a model warns that the archetype turns it off", async () => {
    const { run } = tool();
    const response = await run({
      ...base,
      range: "A1:C3",
      preset: "finance-classic",
      banding: {},
    });
    expect((response.structuredContent as { warnings: string[] }).warnings.join(" ")).toContain(
      "turns banding off",
    );
  });

  test("a footer color is refused by the schema rather than reaching the API", async () => {
    const fake = tool();
    const definition = createStyleTool({ getContext: async () => fake.context });
    const banding = definition.config.inputSchema.banding;
    expect(banding.safeParse({ footer: "#FF0000" }).success).toBe(false);
    expect(banding.safeParse({ first: "#FFFFFF", second: "#EEEEEE" }).success).toBe(true);
  });
});

describe("merges", () => {
  test("a merge overlapping a Table is refused, and the refusal names the shape that works", async () => {
    const withTable = structuredClone(SHEET);
    withTable.tabs[0].tables = [
      {
        tableId: "t1",
        name: "Enrolment",
        range: { sheetId: 0, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 3 },
      },
    ];
    const { run, calls } = tool(withTable);
    const response = await run({ ...base, merge: { range: "A1:C1" } });

    const error = errorOf(response)!;
    expect(error.code).toBe("contract_violation");
    expect(error.message).toContain("Enrolment");
    expect(error.hint).toContain("row above the Table");
    expect(calls.batchUpdate).toHaveLength(0);
  });

  test("a merge inside the data region below a frozen header is refused", async () => {
    const { run } = tool();
    const response = await run({ ...base, merge: { range: "A2:C2" } });
    expect(errorOf(response)?.message).toContain("data region");
  });

  test("a title banner above the header is allowed", async () => {
    const noFreeze = structuredClone(SHEET);
    noFreeze.tabs[0].frozenRowCount = 0;
    const { run, calls } = tool(noFreeze);
    const response = await run({ ...base, merge: { range: "A1:C1" } });
    expect(isFailure(response)).toBe(false);
    expect(requestsOfKind(calls, "mergeCells")[0]["mergeType"]).toBe("MERGE_ALL");
  });

  test("force overrides the refusal", async () => {
    const { run } = tool();
    const response = await run({ ...base, merge: { range: "A2:C2" }, force: true });
    expect(isFailure(response)).toBe(false);
  });

  test("unmerge takes the call's range", async () => {
    const { run, calls } = tool();
    await run({ ...base, range: "A1:C1", unmerge: true });
    expect(requestsOfKind(calls, "unmergeCells")).toHaveLength(1);
  });
});

describe("clearing", () => {
  test("removes banding, conditional rules from the end, merges, and formats", async () => {
    const messy = structuredClone(SHEET);
    messy.tabs[0].bandedRanges = [{ bandedRangeId: 5, range: { sheetId: 0 } }];
    messy.tabs[0].conditionalFormats = 3;
    const { run, calls } = tool(messy);
    await run({
      ...base,
      clear: { formats: true, banding: true, conditional_formats: true, merges: true },
    });

    expect(requestsOfKind(calls, "deleteBanding")).toHaveLength(1);
    const deleted = requestsOfKind(calls, "deleteConditionalFormatRule").map((r) => r["index"]);
    expect(deleted).toEqual([2, 1, 0]);
    expect(requestsOfKind(calls, "unmergeCells")).toHaveLength(1);
    const repeat = requestsOfKind(calls, "repeatCell")[0] as { fields: string };
    expect(repeat.fields).toBe("userEnteredFormat");
  });

  test("clearing formats alone leaves banding and rules standing", async () => {
    const messy = structuredClone(SHEET);
    messy.tabs[0].bandedRanges = [{ bandedRangeId: 5, range: { sheetId: 0 } }];
    messy.tabs[0].conditionalFormats = 2;
    const { run, calls } = tool(messy);
    await run({ ...base, clear: { formats: true } });

    expect(requestsOfKind(calls, "deleteBanding")).toHaveLength(0);
    expect(requestsOfKind(calls, "deleteConditionalFormatRule")).toHaveLength(0);
  });
});

describe("sheet properties", () => {
  test("freeze, gridlines and tab color go in one updateSheetProperties", async () => {
    const { run, calls } = tool();
    await run({ ...base, freeze_rows: 1, gridlines: false, tab_color: "theme:ACCENT1" });

    const properties = requestsOfKind(calls, "updateSheetProperties");
    expect(properties).toHaveLength(1);
    const request = properties[0] as {
      properties: { gridProperties: Record<string, unknown>; tabColorStyle: unknown };
      fields: string;
    };
    expect(request.properties.gridProperties).toMatchObject({ frozenRowCount: 1, hideGridlines: true });
    expect(request.properties.tabColorStyle).toEqual({ themeColor: "ACCENT1" });
    expect(request.fields).toContain("gridProperties.frozenRowCount");
    expect(request.fields).toContain("tabColorStyle");
  });

  test("a tab role resolves through the preset", async () => {
    const { run, calls } = tool();
    await run({ ...base, preset: "park", range: "A1", style: { bold: true }, tab_color: "inputs" });
    const request = requestsOfKind(calls, "updateSheetProperties")[0] as {
      properties: { tabColorStyle: unknown };
    };
    expect(request.properties.tabColorStyle).toEqual({ themeColor: "ACCENT4" });
  });

  test("none clears the tab color", async () => {
    const { run, calls } = tool();
    await run({ ...base, tab_color: "none" });
    const request = requestsOfKind(calls, "updateSheetProperties")[0] as {
      properties: { tabColorStyle: unknown };
    };
    expect(request.properties.tabColorStyle).toEqual({ rgbColor: {} });
  });
});

describe("dimensions and borders", () => {
  test("widths, heights and autofit all land in the one batchUpdate", async () => {
    const { run, calls } = tool();
    await run({
      ...base,
      column_widths: [{ columns: "B:C", pixels: 140 }],
      row_heights: [{ rows: "1", pixels: 34 }],
      autofit: { columns: "A" },
    });

    expect(calls.batchUpdate).toHaveLength(1);
    const dimensions = requestsOfKind(calls, "updateDimensionProperties");
    expect(dimensions).toHaveLength(2);
    expect((dimensions[0]["range"] as Record<string, number>).startIndex).toBe(1);
    expect((dimensions[0]["range"] as Record<string, number>).endIndex).toBe(3);
    expect(requestsOfKind(calls, "autoResizeDimensions")).toHaveLength(1);
  });

  test("borders default to the theme text color and cover the edges asked for", async () => {
    const { run, calls } = tool();
    await run({ ...base, range: "A1:C3", borders: { edges: "outer" } });
    const request = requestsOfKind(calls, "updateBorders")[0] as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(["bottom", "left", "range", "right", "top"]);
    expect((request["top"] as { colorStyle: unknown }).colorStyle).toEqual({ themeColor: "TEXT" });
  });

  test("all covers the inner edges too", async () => {
    const { run, calls } = tool();
    await run({ ...base, range: "A1:C3", borders: { edges: "all", color: "#333333" } });
    const request = requestsOfKind(calls, "updateBorders")[0] as Record<string, unknown>;
    expect(request["innerHorizontal"]).toBeDefined();
    expect(request["innerVertical"]).toBeDefined();
  });
});

describe("somebody else's spreadsheet", () => {
  test("a theme is refused without force and a reason", async () => {
    const { run, calls } = tool(SHEET, SHARED_REGISTRY);
    const response = await run({ spreadsheet_id: WRITE_SPREADSHEET_ID, preset: "park" });

    const error = errorOf(response)!;
    expect(error.code).toBe("needs_confirmation");
    expect(error.message).toContain("shared owned");
    expect(error.hint).toContain("who asked");
    expect(calls.batchUpdate).toHaveLength(0);
  });

  test("force without a reason is still refused", async () => {
    const { run } = tool(SHEET, SHARED_REGISTRY);
    const response = await run({ spreadsheet_id: WRITE_SPREADSHEET_ID, preset: "park", force: true });
    expect(errorOf(response)?.code).toBe("needs_confirmation");
  });

  test("force with a reason goes through", async () => {
    const { run, calls } = tool(SHEET, SHARED_REGISTRY);
    const response = await run({
      spreadsheet_id: WRITE_SPREADSHEET_ID,
      preset: "park",
      force: true,
      reason: "Hadeer asked for the house palette on this tracker.",
    });
    expect(isFailure(response)).toBe(false);
    expect(calls.batchUpdate).toHaveLength(1);
  });

  test("banding and clear are refused the same way", async () => {
    const { run } = tool(SHEET, SHARED_REGISTRY);
    expect(errorOf(await run({ ...base, range: "A1:C3", banding: {} }))?.code).toBe(
      "needs_confirmation",
    );
    expect(errorOf(await run({ ...base, clear: { formats: true } }))?.code).toBe(
      "needs_confirmation",
    );
  });

  test("a tab-wide style is a restyle, but a named range is not", async () => {
    const { run } = tool(SHEET, SHARED_REGISTRY);
    expect(errorOf(await run({ ...base, style: { bold: true } }))?.code).toBe("needs_confirmation");
    expect(isFailure(await run({ ...base, range: "B2:B3", style: { bold: true } }))).toBe(false);
  });

  test("freezing a header on a shared sheet is not a restyle", async () => {
    const { run } = tool(SHEET, SHARED_REGISTRY);
    expect(isFailure(await run({ ...base, freeze_rows: 1 }))).toBe(false);
  });
});

describe("dry_run", () => {
  test("reports the requests and sends none", async () => {
    const { run, calls } = tool();
    const response = await run({ ...base, range: "A1:C1", preset: "park", style: { role: "header" }, dry_run: true });

    expect(calls.batchUpdate).toHaveLength(0);
    const structured = response.structuredContent as { dry_run: boolean; request_count: number };
    expect(structured.dry_run).toBe(true);
    expect(structured.request_count).toBeGreaterThan(0);
  });
});
