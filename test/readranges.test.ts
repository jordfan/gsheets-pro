/**
 * `sheets_read` with several ranges in one call.
 *
 * This replaces the old `get_multiple_sheet_data`, and the reason it exists is
 * quota rather than convenience: reads are capped at sixty a minute, and the
 * commonest way to spend them is a loop of one read per range. One
 * `values.batchGet` costs one.
 *
 * All ids and names are invented.
 */
import { describe, expect, test } from "vitest";

import { errorOf, isFailure } from "../src/lib/result.js";
import { createReadTool } from "../src/tools/read.js";
import { FAKE_SPREADSHEET_ID, makeFakeContext, type FakeSpreadsheet } from "./helpers/fakeContext.js";

const BOOK: FakeSpreadsheet = {
  title: "Fall Enrichment",
  tabs: [
    {
      title: "Roster",
      sheetId: 0,
      index: 0,
      frozenRowCount: 1,
      values: [
        ["Student", "Grade", "Club"],
        ["Ana Reyes", "3", "Clay Studio"],
        ["Bo Tran", "4", "Chess Club"],
      ],
    },
    {
      title: "Fees",
      sheetId: 1,
      index: 1,
      values: [
        ["Club", "Fee"],
        ["Clay Studio", "440"],
        ["Chess Club", "360"],
      ],
    },
    { title: "Empty", sheetId: 2, index: 2, values: [] },
  ],
};

function tool(spreadsheet: FakeSpreadsheet = BOOK) {
  const fake = makeFakeContext(spreadsheet);
  return { ...fake, read: createReadTool({ getContext: async () => fake.context }).handler };
}

interface Block {
  requested: string;
  range: string;
  rows: number;
  columns: number;
  values: unknown[][];
}

const blocksOf = (response: { structuredContent?: Record<string, unknown> }): Block[] =>
  (response.structuredContent?.["blocks"] ?? []) as Block[];

describe("several ranges at once", () => {
  test("reads ranges across two tabs in a single batchGet", async () => {
    const { read, calls } = tool();
    const response = await read({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      ranges: ["Roster!A1:C3", "Fees!A1:B3"],
    });

    expect(isFailure(response)).toBe(false);
    // One call is the entire point.
    expect(calls.batchGet).toHaveLength(1);
    expect((calls.batchGet[0] as { ranges: string[] }).ranges).toHaveLength(2);

    const blocks = blocksOf(response);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].values[1]).toEqual(["Ana Reyes", "3", "Clay Studio"]);
    expect(blocks[1].values[1]).toEqual(["Clay Studio", "440"]);
  });

  test("blocks come back in the order they were asked for", async () => {
    const { read } = tool();
    const response = await read({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      ranges: ["Fees!A1:B2", "Roster!A1:C2"],
    });

    const blocks = blocksOf(response);
    expect(blocks.map((b) => b.requested)).toEqual(["Fees!A1:B2", "Roster!A1:C2"]);
  });

  test("an unqualified range takes the sheet argument as its tab", async () => {
    const { read, calls } = tool();
    const response = await read({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      sheet: "Roster",
      ranges: ["A1:C2", "A3:C3"],
    });

    expect(isFailure(response)).toBe(false);
    const sent = (calls.batchGet[0] as { ranges: string[] }).ranges;
    expect(sent.every((r) => r.includes("Roster"))).toBe(true);
  });

  test("a qualified range keeps its own tab even when sheet is given", async () => {
    const { read, calls } = tool();
    await read({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      sheet: "Roster",
      ranges: ["A1:C2", "Fees!A1:B2"],
    });

    const sent = (calls.batchGet[0] as { ranges: string[] }).ranges;
    expect(sent[0]).toContain("Roster");
    expect(sent[1]).toContain("Fees");
  });

  test("an unqualified range with no sheet is refused, and the refusal says both fixes", async () => {
    const { read } = tool();
    const response = await read({ spreadsheet_id: FAKE_SPREADSHEET_ID, ranges: ["A1:C2"] });

    expect(isFailure(response)).toBe(true);
    expect(errorOf(response)?.message).toContain("does not say which tab");
    expect(errorOf(response)?.hint).toContain("Roster!A1:C20");
    expect(errorOf(response)?.hint).toContain("pass sheet");
  });

  test("each block reports its own shape", async () => {
    const { read } = tool();
    const response = await read({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      ranges: ["Roster!A1:C3", "Fees!A1:B2"],
    });

    const blocks = blocksOf(response);
    expect(blocks[0]).toMatchObject({ rows: 3, columns: 3 });
    expect(blocks[1]).toMatchObject({ rows: 2, columns: 2 });
  });

  test("an empty range is reported rather than passed over in silence", async () => {
    const { read } = tool();
    const response = await read({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      ranges: ["Roster!A1:C2", "Empty!A1:B5"],
    });

    expect(isFailure(response)).toBe(false);
    const warnings = (response.structuredContent as { warnings: string[] }).warnings;
    expect(warnings.join(" ")).toContain("Empty!A1:B5");
    expect(warnings.join(" ")).toContain("not an error");
  });

  test("formulas can be asked for across every range at once", async () => {
    const withFormulas = structuredClone(BOOK);
    withFormulas.tabs[1].formulas = [
      ["Club", "Fee"],
      ["Clay Studio", "=55*8"],
      ["Chess Club", "=45*8"],
    ];
    const { read, calls } = tool(withFormulas);
    const response = await read({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      ranges: ["Fees!A1:B3"],
      values: "formulas",
    });

    expect((calls.batchGet[0] as { valueRenderOption: string }).valueRenderOption).toBe("FORMULA");
    expect(blocksOf(response)[0].values[1]).toEqual(["Clay Studio", "=55*8"]);
  });

  test("the prose names every range and its size", async () => {
    const { read } = tool();
    const response = await read({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      ranges: ["Roster!A1:C3", "Fees!A1:B3"],
    });

    const text = response.content[0].text;
    expect(text).toContain("2 ranges read in one call");
    expect(text).toContain("Roster");
    expect(text).toContain("Fees");
  });

  test("too many ranges is refused rather than answered with an unreadable wall", async () => {
    const { read } = tool();
    const many = Array.from({ length: 30 }, (_, i) => `Roster!A${i + 1}:C${i + 1}`);
    const response = await read({ spreadsheet_id: FAKE_SPREADSHEET_ID, ranges: many });

    expect(errorOf(response)?.message).toContain("30 ranges");
    expect(errorOf(response)?.hint).toContain("at most");
  });

  test("an empty string among the ranges is caught", async () => {
    const { read } = tool();
    const response = await read({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      ranges: ["Roster!A1:C2", "   "],
    });
    expect(errorOf(response)?.message).toContain("empty");
  });
});

describe("what ranges does not change", () => {
  test("a single range read still returns records, which ranges deliberately does not", async () => {
    const { read } = tool();
    const single = await read({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      sheet: "Roster",
      range: "A1:C3",
    });

    const structured = single.structuredContent as { shape: string; records?: unknown[] };
    expect(structured.shape).toBe("records");
    expect(structured.records).toBeDefined();
  });

  test("ranges returns grids, because scattered blocks rarely share a header row", async () => {
    const { read } = tool();
    const response = await read({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      ranges: ["Roster!A1:C3"],
    });
    expect((response.structuredContent as { shape: string }).shape).toBe("ranges");
  });

  test("find still wins over ranges when both are passed", async () => {
    const { read } = tool();
    const response = await read({
      spreadsheet_id: FAKE_SPREADSHEET_ID,
      ranges: ["Roster!A1:C3"],
      find: { query: "Chess Club" },
    });
    const structured = response.structuredContent as { hits?: unknown[]; blocks?: unknown[] };
    expect(structured.hits).toBeDefined();
    expect(structured.blocks).toBeUndefined();
  });
});
