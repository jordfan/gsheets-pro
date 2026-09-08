/**
 * `sheets_check` end to end over a fake spreadsheet.
 *
 * The rules are tested on their own in `lint.test.ts`. What matters here is the
 * envelope: the two reads happening in the right order and bounded to real
 * data, the recalculation shaped summary, the three statuses, and the prose
 * saying the one thing a render cannot.
 */

import { describe, expect, test, beforeEach } from "vitest";

import { createCheckTool } from "../src/tools/check.js";
import { clearWrites, recordWrite } from "../src/lib/writelog.js";
import { errorOf } from "../src/lib/result.js";
import { makeCheckContext, FIXTURE_SPREADSHEET_ID, type FakeTabSpec } from "./helpers/fakeCheckContext.js";
import { registryJson } from "./helpers/lintFixtures.js";

const ROSTER: FakeTabSpec = {
  title: "Roster",
  sheetId: 11,
  frozenRows: 1,
  rows: [
    [
      { value: "Student", bold: true },
      { value: "Teacher", bold: true },
      { value: "Sessions", bold: true },
      { value: "Fee", bold: true },
    ],
    ["Nell Ashgrove", "Bellweather", 16, "=C2*80"],
    ["Iver Tolman", "Bellweather", 16, "=C3*80"],
  ],
};

function toolFor(tabs: FakeTabSpec[], options?: Parameters<typeof makeCheckContext>[1]) {
  const { context, calls } = makeCheckContext(tabs, options);
  // A short LOADING budget: the retry behaviour is what is under test, not how
  // long a person waits for it.
  const tool = createCheckTool({ getContext: async () => context }, { loadingBudgetMs: 120 });
  return { tool, calls, context };
}

beforeEach(() => {
  clearWrites();
});

describe("the shape of the report", () => {
  test("a clean spreadsheet reports success with the recalculation fields", async () => {
    const { tool } = toolFor([ROSTER]);
    const response = await tool.handler({ spreadsheet_id: FIXTURE_SPREADSHEET_ID });
    const body = response.structuredContent as Record<string, unknown>;

    expect(body.status).toBe("success");
    expect(body.total_formulas).toBe(2);
    expect(body.total_errors).toBe(0);
    expect(body.error_summary).toEqual({});
    expect(body.findings).toEqual([]);
    expect(body.sheets_checked).toEqual(["Roster"]);
    expect(response.content[0].text).toContain("Check: success");
  });

  test("errors_found carries the type, the count and the locations", async () => {
    const { tool } = toolFor([
      {
        ...ROSTER,
        rows: [
          ROSTER.rows[0],
          ["Nell Ashgrove", "Bellweather", 16, { formula: "=C2*Rate", error: "NAME" }],
          ["Iver Tolman", "Bellweather", 16, { formula: "=C3*Rate", error: "NAME" }],
        ],
      },
    ]);
    const response = await tool.handler({ spreadsheet_id: FIXTURE_SPREADSHEET_ID });
    const body = response.structuredContent as Record<string, unknown>;

    expect(body.status).toBe("errors_found");
    expect(body.total_errors).toBe(2);
    expect(body.error_summary).toEqual({
      NAME: { count: 2, locations: ["Roster!D2", "Roster!D3"], truncated: 0 },
    });
    expect(response.content[0].text).toContain("errors_found");
  });

  test("warnings alone still read as success", async () => {
    // A tab with a bold header and no frozen row: L09 fires, nothing is broken.
    const { tool } = toolFor([{ ...ROSTER, frozenRows: 0 }]);
    const body = (await tool.handler({ spreadsheet_id: FIXTURE_SPREADSHEET_ID }))
      .structuredContent as Record<string, unknown>;
    expect(body.status).toBe("success");
    expect((body.counts as Record<string, number>).warning).toBe(1);
    expect((body.findings as Array<{ rule: string }>)[0].rule).toBe("L09");
  });

  test("cells still calculating report pending, not success", async () => {
    const { tool } = toolFor([ROSTER], { settleAfter: 99 });
    const body = (await tool.handler({ spreadsheet_id: FIXTURE_SPREADSHEET_ID }))
      .structuredContent as Record<string, unknown>;
    expect(body.status).toBe("pending");
    expect(body.total_errors).toBe(0);
    expect((body.notes as string[]).join(" ")).toContain("still calculating");
  }, 20_000);

  test("LOADING that settles on a retry reports success", async () => {
    const { tool, calls } = toolFor([ROSTER], { settleAfter: 1 });
    const body = (await tool.handler({ spreadsheet_id: FIXTURE_SPREADSHEET_ID }))
      .structuredContent as Record<string, unknown>;
    expect(body.status).toBe("success");
    expect(calls.get.length).toBeGreaterThan(1);
  }, 20_000);

  test("the prose always says what a render cannot show", async () => {
    const { tool } = toolFor([ROSTER]);
    const response = await tool.handler({ spreadsheet_id: FIXTURE_SPREADSHEET_ID });
    expect(response.content[0].text).toContain("No dropdown paints as a pill in a render");
    expect(response.content[0].text).toContain("authority on validation state");
  });
});

describe("the two reads", () => {
  test("values come first, with FORMULA rendering", async () => {
    const { tool, calls } = toolFor([ROSTER]);
    await tool.handler({ spreadsheet_id: FIXTURE_SPREADSHEET_ID });
    expect(calls.batchGet).toHaveLength(1);
    expect(calls.batchGet[0].valueRenderOption).toBe("FORMULA");
    expect(calls.batchGet[0].ranges).toEqual(["'Roster'"]);
  });

  test("the grid read is bounded to the used range, not the whole tab", async () => {
    const { tool, calls } = toolFor([ROSTER]);
    await tool.handler({ spreadsheet_id: FIXTURE_SPREADSHEET_ID });
    expect(calls.get[0].ranges).toEqual(["'Roster'!A1:D3"]);
    expect(calls.get[0].fields).toContain("errorValue");
    expect(calls.get[0].fields).toContain("note");
  });

  test("a range narrows both reads", async () => {
    const { tool, calls } = toolFor([ROSTER]);
    await tool.handler({ spreadsheet_id: FIXTURE_SPREADSHEET_ID, sheet: "Roster", range: "A1:B2" });
    expect(calls.batchGet[0].ranges).toEqual(["'Roster'!A1:B2"]);
  });

  test("a range with no tab named is refused with a hint that shows the fix", async () => {
    const { tool } = toolFor([ROSTER]);
    const response = await tool.handler({ spreadsheet_id: FIXTURE_SPREADSHEET_ID, range: "A1:B2" });
    expect(response.isError).toBe(true);
    expect(errorOf(response)?.hint).toContain('"sheet"');
  });

  test("hidden tabs are skipped unless named", async () => {
    const { tool } = toolFor([ROSTER, { title: "Scratch", sheetId: 12, hidden: true, rows: [["x"]] }]);
    const body = (await tool.handler({ spreadsheet_id: FIXTURE_SPREADSHEET_ID }))
      .structuredContent as Record<string, unknown>;
    expect(body.sheets_checked).toEqual(["Roster"]);

    const named = (await tool.handler({ spreadsheet_id: FIXTURE_SPREADSHEET_ID, sheets: ["Scratch"] }))
      .structuredContent as Record<string, unknown>;
    expect(named.sheets_checked).toEqual(["Scratch"]);
  });
});

describe("rule selection", () => {
  test("rules narrows what runs", async () => {
    const { tool } = toolFor([{ ...ROSTER, frozenRows: 0 }]);
    const body = (await tool.handler({ spreadsheet_id: FIXTURE_SPREADSHEET_ID, rules: ["L01"] }))
      .structuredContent as Record<string, unknown>;
    expect(body.rules_run).toEqual(["L01"]);
    expect(body.findings).toEqual([]);
  });

  test("an unknown rule is reported in the notes rather than ignored", async () => {
    const { tool } = toolFor([ROSTER]);
    const body = (await tool.handler({ spreadsheet_id: FIXTURE_SPREADSHEET_ID, rules: ["L01", "L77"] }))
      .structuredContent as Record<string, unknown>;
    expect((body.notes as string[]).join(" ")).toContain("L77");
  });

  test("every rule being unknown is an error, not a silent clean bill of health", async () => {
    const { tool } = toolFor([ROSTER]);
    const response = await tool.handler({ spreadsheet_id: FIXTURE_SPREADSHEET_ID, rules: ["L77"] });
    expect(response.isError).toBe(true);
  });
});

describe("the contract driven rules", () => {
  test("a registry entry makes L14 report a write into a withheld column", async () => {
    const tracker: FakeTabSpec = {
      title: "Tracker",
      sheetId: 21,
      frozenRows: 1,
      rows: [
        ["Vendor", "Instructor", "Email", "Fingerprints"],
        ["Clay & Kiln", "Oren Whitfield", "oren@example.com", "2026-09-01"],
      ],
    };
    const { tool } = toolFor([tracker], {
      registryJson: registryJson({ owner: "shared", writable_columns: ["A", "B", "C"] }),
    });

    recordWrite({ spreadsheetId: FIXTURE_SPREADSHEET_ID, range: "'Tracker'!D2", tool: "sheets_write" });

    const body = (await tool.handler({ spreadsheet_id: FIXTURE_SPREADSHEET_ID }))
      .structuredContent as Record<string, unknown>;
    const findings = body.findings as Array<{ rule: string; location: string }>;
    expect(findings.some((f) => f.rule === "L14" && f.location.startsWith("Tracker!D"))).toBe(true);
  });

  test("writes passed in by the caller count too", async () => {
    const tracker: FakeTabSpec = {
      title: "Tracker",
      sheetId: 21,
      frozenRows: 1,
      rows: [
        ["Vendor", "Instructor", "Email", "Fingerprints"],
        ["Clay & Kiln", "Oren Whitfield", "oren@example.com", "2026-09-01"],
      ],
    };
    const { tool } = toolFor([tracker], {
      registryJson: registryJson({ owner: "shared", writable_columns: ["A", "B", "C"] }),
    });
    const body = (await tool.handler({
      spreadsheet_id: FIXTURE_SPREADSHEET_ID,
      writes: ["'Tracker'!D2:D9"],
    })).structuredContent as Record<string, unknown>;
    expect((body.findings as Array<{ rule: string }>).some((f) => f.rule === "L14")).toBe(true);
  });

  test("column metadata reaches the rules that need a contract", async () => {
    const { tool } = toolFor(
      [
        {
          title: "Roster",
          sheetId: 11,
          frozenRows: 1,
          rows: [
            ["Student", "Email", "Check"],
            ["Nell Ashgrove", "nell@example.com", "Missing phone"],
          ],
        },
      ],
      {
        developerMetadata: [
          {
            metadataKey: "gsheets.column",
            metadataValue: JSON.stringify({ name: "check", header: "Check", role: "check" }),
            location: { dimensionRange: { sheetId: 11, dimension: "COLUMNS", startIndex: 2 } },
          },
        ],
      },
    );
    const body = (await tool.handler({ spreadsheet_id: FIXTURE_SPREADSHEET_ID }))
      .structuredContent as Record<string, unknown>;
    const findings = body.findings as Array<{ rule: string; message: string }>;
    const l22 = findings.find((f) => f.rule === "L22");
    expect(l22).toBeDefined();
    expect(l22?.message).toContain("Missing phone");
  });

  test("a spreadsheet whose metadata search fails still lints", async () => {
    const { tool } = toolFor([ROSTER], { metadataThrows: true });
    const body = (await tool.handler({ spreadsheet_id: FIXTURE_SPREADSHEET_ID }))
      .structuredContent as Record<string, unknown>;
    expect(body.status).toBe("success");
  });
});
