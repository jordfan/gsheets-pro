/**
 * `sheets_conditional_format`. The behaviour under test is the addressing: no
 * index ever crosses the tool boundary, and a fingerprint that no longer
 * matches produces the current list rather than a wrong edit.
 *
 * All ids and names are invented.
 */
import { describe, expect, test } from "vitest";

import { fingerprintRule, type CfRule } from "../src/lib/cfrules.js";
import { errorOf, isFailure } from "../src/lib/result.js";
import { createConditionalFormatTool } from "../src/tools/conditional_format.js";
import {
  FAKE_ID,
  makeMutableContext,
  requestsOfKind,
  sheetMetadata,
  type FakeWorkbook,
} from "./helpers/fakeMutableContext.js";

const overdue: CfRule = {
  ranges: [{ sheetId: 0, startRowIndex: 1, endRowIndex: 40, startColumnIndex: 2, endColumnIndex: 3 }],
  booleanRule: {
    condition: { type: "TEXT_EQ", values: [{ userEnteredValue: "Overdue" }] },
    format: { backgroundColorStyle: { rgbColor: { red: 0.96, green: 0.886, blue: 0.878 } } },
  },
};

const confirmed: CfRule = {
  ranges: [{ sheetId: 0, startRowIndex: 1, endRowIndex: 40, startColumnIndex: 2, endColumnIndex: 3 }],
  booleanRule: {
    condition: { type: "TEXT_EQ", values: [{ userEnteredValue: "Confirmed" }] },
    format: { backgroundColorStyle: { rgbColor: { red: 0.89, green: 0.941, blue: 0.914 } } },
  },
};

const WORKBOOK: FakeWorkbook = {
  tabs: [
    { title: "Tracker", sheetId: 0, conditionalFormats: [confirmed, overdue] },
    { title: "Notes", sheetId: 1 },
  ],
};

function tool(workbook: FakeWorkbook = WORKBOOK) {
  const { context, calls, requests } = makeMutableContext(workbook);
  return {
    cf: createConditionalFormatTool({ getContext: async () => context }),
    calls,
    requests,
  };
}

describe("list", () => {
  test("prints every rule with its fingerprint and its evaluation order", async () => {
    const { cf } = tool();
    const result = await cf.handler({ spreadsheet_id: FAKE_ID, action: "list" });
    expect(isFailure(result)).toBe(false);
    expect(result.content[0].text).toMatch(/first match wins/);
    expect(result.content[0].text).toContain(fingerprintRule(overdue));

    const sheets = (result.structuredContent as Record<string, never>)["sheets"] as Array<{
      sheet: string;
      rules: Array<{ index: number; fingerprint: string }>;
    }>;
    expect(sheets[0].rules.map((r) => r.index)).toEqual([0, 1]);
    expect(sheets[1].rules).toEqual([]);
  });

  test("one tab can be asked for on its own", async () => {
    const { cf } = tool();
    const result = await cf.handler({ spreadsheet_id: FAKE_ID, action: "list", sheet: "Notes" });
    const sheets = (result.structuredContent as Record<string, never>)["sheets"] as unknown[];
    expect(sheets).toHaveLength(1);
    expect(result.content[0].text).toMatch(/no conditional format rules/);
  });

  test("an unknown tab lists the ones that exist", async () => {
    const { cf } = tool();
    const result = await cf.handler({ spreadsheet_id: FAKE_ID, action: "list", sheet: "Ledger" });
    expect(errorOf(result)?.code).toBe("sheet_not_found");
  });
});

describe("add", () => {
  test("a role name resolves against the preset the sheet records", async () => {
    const parkTab: FakeWorkbook = {
      ...WORKBOOK,
      developerMetadata: [sheetMetadata(0, { preset: "park" })],
    };
    const { cf, requests } = tool(parkTab);
    const result = await cf.handler({
      spreadsheet_id: FAKE_ID,
      action: "add",
      sheet: "Tracker",
      ranges: ["C2:C40"],
      operator: "equal",
      value_kind: "text",
      value: "Cancelled",
      format: { fill: "flag", strikethrough: true },
    });
    expect(isFailure(result)).toBe(false);
    const [request] = requestsOfKind<{ rule: CfRule; index: number }>(
      requests(),
      "addConditionalFormatRule",
    );
    expect(request.rule.booleanRule?.format?.backgroundColorStyle).toBeDefined();
    expect(request.rule.booleanRule?.format?.textFormat?.strikethrough).toBe(true);
    expect(request.index).toBe(2);
  });

  test("the new rule's fingerprint comes back, ready for a later update", async () => {
    const { cf } = tool();
    const result = await cf.handler({
      spreadsheet_id: FAKE_ID,
      action: "add",
      sheet: "Tracker",
      ranges: ["C2:C40"],
      operator: "contains",
      value: "hold",
      format: { fill: "warn" },
    });
    expect((result.structuredContent as Record<string, never>)["fingerprint"]).toMatch(/^cf_/);
    expect(result.content[0].text).toMatch(/Fingerprint: cf_/);
  });

  test("inserting ahead of the existing rules says what it now runs before", async () => {
    const { cf } = tool();
    const result = await cf.handler({
      spreadsheet_id: FAKE_ID,
      action: "add",
      sheet: "Tracker",
      ranges: ["C2:C40"],
      operator: "blank",
      format: { fill: "muted" },
      index: 0,
    });
    expect(result.content[0].text).toMatch(/runs before 2 existing rules/);
  });

  test("a gradient needs its points and its anchors", async () => {
    const { cf, requests } = tool();
    const ok = await cf.handler({
      spreadsheet_id: FAKE_ID,
      action: "add",
      sheet: "Tracker",
      ranges: ["D2:D40"],
      kind: "gradient",
      gradient: {
        min: { type: "MIN", color: "#FFFFFF" },
        max: { type: "MAX", color: "ok" },
      },
    });
    expect(isFailure(ok)).toBe(false);
    expect(requestsOfKind<{ rule: CfRule }>(requests(), "addConditionalFormatRule")[0].rule.gradientRule).toBeDefined();

    const missingValue = await cf.handler({
      spreadsheet_id: FAKE_ID,
      action: "add",
      sheet: "Tracker",
      ranges: ["D2:D40"],
      kind: "gradient",
      gradient: {
        min: { type: "NUMBER", color: "#FFFFFF" },
        max: { type: "MAX", color: "ok" },
      },
    });
    expect(errorOf(missingValue)?.code).toBe("invalid_argument");
  });

  test("a rule with no format is refused, because it would paint nothing", async () => {
    const { cf } = tool();
    const result = await cf.handler({
      spreadsheet_id: FAKE_ID,
      action: "add",
      sheet: "Tracker",
      ranges: ["C2:C40"],
      operator: "blank",
    });
    expect(result.content[0].text).toMatch(/paints nothing/);
  });

  test("ranges are required", async () => {
    const { cf, calls } = tool();
    const result = await cf.handler({
      spreadsheet_id: FAKE_ID,
      action: "add",
      sheet: "Tracker",
      operator: "blank",
      format: { fill: "muted" },
    });
    expect(errorOf(result)?.code).toBe("invalid_argument");
    expect(calls.batchUpdate).toHaveLength(0);
  });
});

describe("update", () => {
  test("a fingerprint resolves to the index the API wants", async () => {
    const { cf, requests } = tool();
    const result = await cf.handler({
      spreadsheet_id: FAKE_ID,
      action: "update",
      sheet: "Tracker",
      fingerprint: fingerprintRule(overdue),
      format: { fill: "flag", bold: true },
    });
    expect(isFailure(result)).toBe(false);
    const [request] = requestsOfKind<{ index: number; sheetId: number; rule: CfRule }>(
      requests(),
      "updateConditionalFormatRule",
    );
    expect(request.index).toBe(1);
    expect(request.sheetId).toBe(0);
  });

  test("changing only the colour keeps the condition it painted on", async () => {
    const { cf, requests } = tool();
    await cf.handler({
      spreadsheet_id: FAKE_ID,
      action: "update",
      sheet: "Tracker",
      fingerprint: fingerprintRule(overdue),
      format: { fill: "warn" },
    });
    const [request] = requestsOfKind<{ rule: CfRule }>(requests(), "updateConditionalFormatRule");
    expect(request.rule.booleanRule?.condition).toEqual(overdue.booleanRule?.condition);
  });

  test("a rule whose ranges shifted is found and the move is reported", async () => {
    const moved: CfRule = {
      ...overdue,
      ranges: [{ sheetId: 0, startRowIndex: 5, endRowIndex: 90, startColumnIndex: 2, endColumnIndex: 3 }],
    };
    const { cf } = tool({ tabs: [{ title: "Tracker", sheetId: 0, conditionalFormats: [moved] }] });
    const result = await cf.handler({
      spreadsheet_id: FAKE_ID,
      action: "update",
      sheet: "Tracker",
      fingerprint: fingerprintRule(overdue),
      format: { fill: "warn" },
    });
    expect(isFailure(result)).toBe(false);
    expect(result.content[0].text).toMatch(/ranges had shifted/);
  });

  test("a fingerprint that matches nothing hands back the current list", async () => {
    const { cf, calls } = tool();
    const result = await cf.handler({
      spreadsheet_id: FAKE_ID,
      action: "update",
      sheet: "Tracker",
      fingerprint: "cf_0000000000_aaaaaa",
      format: { fill: "warn" },
    });
    expect(errorOf(result)?.code).toBe("invalid_argument");
    expect(result.content[0].text).toContain(fingerprintRule(confirmed));
    expect(calls.batchUpdate).toHaveLength(0);
  });

  test("no fingerprint at all explains why an index is not accepted", async () => {
    const { cf } = tool();
    const result = await cf.handler({
      spreadsheet_id: FAKE_ID,
      action: "update",
      sheet: "Tracker",
      format: { fill: "warn" },
    });
    expect(result.content[0].text).toMatch(/Indexes are not accepted/);
  });
});

describe("delete", () => {
  test("removes the rule and warns that the ones below moved up", async () => {
    const { cf, requests } = tool();
    const result = await cf.handler({
      spreadsheet_id: FAKE_ID,
      action: "delete",
      sheet: "Tracker",
      fingerprint: fingerprintRule(confirmed),
    });
    expect(requestsOfKind(requests(), "deleteConditionalFormatRule")[0]).toEqual({
      sheetId: 0,
      index: 0,
    });
    expect(result.content[0].text).toMatch(/moved up by one/);
  });

  test("a dry run sends nothing", async () => {
    const { cf, calls } = tool();
    await cf.handler({
      spreadsheet_id: FAKE_ID,
      action: "delete",
      sheet: "Tracker",
      fingerprint: fingerprintRule(confirmed),
      dry_run: true,
    });
    expect(calls.batchUpdate).toHaveLength(0);
  });
});
