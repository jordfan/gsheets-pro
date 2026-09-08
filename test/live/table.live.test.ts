/**
 * The live round trip for the four Phase 3 tools.
 *
 * Gated: it runs only when `GSHEETS_PRO_LIVE_SPREADSHEET` names a disposable
 * spreadsheet and a credential is reachable. It creates its own tabs, prefixed
 * so they are obvious, and deletes them at the end.
 *
 * The offline suite proves the requests are the right shape. This proves the
 * API accepts them, which is a different question and the one that caught
 * `footerColorStyle` in spike 3.
 *
 * Every name in the fixture data is invented.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { getContext, type Context } from "../../src/lib/client.js";
import { fingerprintRule } from "../../src/lib/cfrules.js";
import { isFailure } from "../../src/lib/result.js";
import { createConditionalFormatTool } from "../../src/tools/conditional_format.js";
import { createSettingsTool } from "../../src/tools/settings.js";
import { createTableTool } from "../../src/tools/table.js";
import { createValidationTool } from "../../src/tools/validation.js";

const SPREADSHEET_ID = process.env.GSHEETS_PRO_LIVE_SPREADSHEET;
const suite = SPREADSHEET_ID ? describe : describe.skip;

/** A run stamp, so two runs never collide on a tab name. */
const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(8, 14);
const TABLE_TAB = `Table ${stamp}`;
const SETTINGS_TAB = `Settings ${stamp}`;
const VALID_TAB = `Valid ${stamp}`;
const CF_TAB = `CF ${stamp}`;

let ctx: Context;
let madeSheetIds: number[] = [];
let tools: {
  table: ReturnType<typeof createTableTool>;
  settings: ReturnType<typeof createSettingsTool>;
  validation: ReturnType<typeof createValidationTool>;
  cf: ReturnType<typeof createConditionalFormatTool>;
};

const HEADERS = ["Instructor", "Vendor", "Status", "Sessions", "Fee"];
const ROWS = [
  ["Nadia Okonkwo", "Bright Circuits", "Confirmed", 8, "=D2*55"],
  ["Emil Sandoval", "Bright Circuits", "Pending", 8, "=D3*55"],
  ["Thea Vasquez", "Clay & Kiln", "Declined", 6, "=D4*55"],
];

suite("live: the Phase 3 tools", () => {
  beforeAll(async () => {
    ctx = await getContext();
    const deps = { getContext: async () => ctx };
    tools = {
      table: createTableTool(deps),
      settings: createSettingsTool(deps),
      validation: createValidationTool(deps),
      cf: createConditionalFormatTool(deps),
    };

    const created = await ctx.sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID!,
      requestBody: {
        requests: [TABLE_TAB, SETTINGS_TAB, VALID_TAB, CF_TAB].map((title) => ({
          addSheet: { properties: { title } },
        })),
      },
    });
    // Keep the ids from the reply. Looking them up again at teardown would
    // spend a read from a 60 per minute budget this suite has already used.
    madeSheetIds = (created.data.replies ?? []).flatMap((reply) => {
      const id = reply.addSheet?.properties?.sheetId;
      return id === undefined || id === null ? [] : [id];
    });
    ctx.cache.invalidate(SPREADSHEET_ID!);

    await ctx.sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID!,
      range: `'${TABLE_TAB}'!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [HEADERS, ...ROWS] },
    });
    await ctx.sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID!,
      range: `'${VALID_TAB}'!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [["Instructor", "Status"], ["Nadia Okonkwo", "Confirmed"]] },
    });
    await ctx.sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID!,
      range: `'${CF_TAB}'!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [["Status"], ["Overdue"], ["Confirmed"]] },
    });
  }, 60_000);

  afterAll(async () => {
    if (!ctx || !madeSheetIds.length) return;
    await ctx.sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID!,
      requestBody: { requests: madeSheetIds.map((sheetId) => ({ deleteSheet: { sheetId } })) },
    });
  }, 60_000);

  test("sheets_table create survives the API, formulas and all", async () => {
    const result = await tools.table.handler({
      spreadsheet_id: SPREADSHEET_ID,
      sheet: TABLE_TAB,
      action: "create",
      name: `Instructors_${stamp}`,
      range: "A1:E4",
      columns: [
        { name: "Instructor", role: "key", key: "instructor" },
        { name: "Vendor" },
        {
          name: "Status",
          type: "DROPDOWN",
          options: ["Confirmed", "Pending", "Declined"],
          role: "status",
        },
        { name: "Sessions", type: "DOUBLE" },
        { name: "Fee", type: "CURRENCY", note: "Vendor rate times sessions." },
      ],
      status_fill_rules: true,
    });
    expect(isFailure(result)).toBe(false);
    const structured = result.structuredContent as Record<string, never>;
    expect(structured["table_id"]).toBeTruthy();
    expect(structured["filtered"]).toBe(true);

    // The formulas that were in the range before the Table have to survive it.
    const values = await ctx.sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID!,
      range: `'${TABLE_TAB}'!E2:E4`,
      valueRenderOption: "FORMULA",
    });
    expect(values.data.values?.[0]?.[0]).toBe("=D2*55");

    // And the Table has to read back with its typed columns and its colours.
    const state = await ctx.sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID!,
      fields: "sheets(properties(title,gridProperties.frozenRowCount),tables(name,range,rowsProperties,columnProperties(columnName,columnType,dataValidationRule)),basicFilter,conditionalFormats)",
    });
    const sheet = (state.data.sheets ?? []).find((s) => s.properties?.title === TABLE_TAB);
    const table = sheet?.tables?.[0];
    expect(table?.columnProperties?.map((c) => c.columnType)).toEqual([
      undefined,
      undefined,
      "DROPDOWN",
      "DOUBLE",
      "CURRENCY",
    ]);
    expect(table?.rowsProperties?.headerColorStyle).toBeDefined();
    expect(table?.rowsProperties?.footerColorStyle).toBeUndefined();
    expect(sheet?.properties?.gridProperties?.frozenRowCount).toBe(1);
    expect(sheet?.basicFilter).toBeDefined();
    expect(sheet?.conditionalFormats?.length).toBe(3);
  }, 60_000);

  test("the contract metadata reads back at PROJECT visibility", async () => {
    const search = await ctx.sheets.spreadsheets.developerMetadata.search({
      spreadsheetId: SPREADSHEET_ID!,
      requestBody: { dataFilters: [{ developerMetadataLookup: { metadataKey: "gsheets.column" } }] },
    });
    const entries = (search.data.matchedDeveloperMetadata ?? []).map((m) => m.developerMetadata);
    expect(entries.length).toBeGreaterThanOrEqual(5);
    expect(entries.every((e) => e?.visibility === "PROJECT")).toBe(true);
  }, 30_000);

  test("sheets_table update replaces the dropdown options it owns", async () => {
    const result = await tools.table.handler({
      spreadsheet_id: SPREADSHEET_ID,
      sheet: TABLE_TAB,
      action: "update",
      name: `Instructors_${stamp}`,
      columns: [
        { name: "Instructor", role: "key" },
        { name: "Vendor" },
        {
          name: "Status",
          type: "DROPDOWN",
          options: ["Confirmed", "Pending", "Declined", "On hold"],
          role: "status",
        },
        { name: "Sessions", type: "DOUBLE" },
        { name: "Fee", type: "CURRENCY" },
      ],
    });
    expect(isFailure(result)).toBe(false);

    const state = await ctx.sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID!,
      fields: "sheets(properties.title,tables(columnProperties(columnName,dataValidationRule)))",
    });
    const status = (state.data.sheets ?? [])
      .find((s) => s.properties?.title === TABLE_TAB)
      ?.tables?.[0]?.columnProperties?.find((c) => c.columnName === "Status");
    expect(status?.dataValidationRule?.condition?.values?.map((v) => v.userEnteredValue)).toEqual([
      "Confirmed",
      "Pending",
      "Declined",
      "On hold",
    ]);
  }, 60_000);

  test("sheets_settings writes a block whose named ranges resolve in a formula", async () => {
    const result = await tools.settings.handler({
      spreadsheet_id: SPREADSHEET_ID,
      sheet: SETTINGS_TAB,
      title: "Assumptions",
      items: [
        {
          label: `Fee per session ${stamp}`,
          value: 55,
          unit: "dollars",
          source: "invented figure",
          format: "currency",
        },
        { label: `Sessions per term ${stamp}`, value: 8, unit: "sessions", format: "integer" },
        {
          label: `Term total ${stamp}`,
          value: `=Fee_per_session_${stamp}*Sessions_per_term_${stamp}`,
          format: "currency",
        },
      ],
    });
    expect(isFailure(result)).toBe(false);
    const check = (result.structuredContent as Record<string, never>)["check"] as { status: string };
    // The total is a formula over the two named ranges above it. If the names
    // did not take, this reads errors_found rather than ok.
    expect(check.status).toBe("ok");

    const values = await ctx.sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID!,
      range: `'${SETTINGS_TAB}'!B5`,
    });
    expect(Number(String(values.data.values?.[0]?.[0] ?? "0").replace(/[^0-9.]/g, ""))).toBe(440);
  }, 60_000);

  test("sheets_validation sets a dropdown and then refuses to rewrite somebody else's", async () => {
    const first = await tools.validation.handler({
      spreadsheet_id: SPREADSHEET_ID,
      sheet: VALID_TAB,
      range: "B2:B40",
      type: "list",
      values: ["Confirmed", "Pending"],
      help: "Where the vendor has got to.",
    });
    expect(isFailure(first)).toBe(false);

    // Nothing recorded that column as the plugin's, so the second call has to
    // treat the rule it just made as somebody's and refuse.
    const second = await tools.validation.handler({
      spreadsheet_id: SPREADSHEET_ID,
      sheet: VALID_TAB,
      range: "B2:B40",
      type: "list",
      values: ["Confirmed", "Pending", "Declined"],
    });
    expect(isFailure(second)).toBe(true);
    expect(second.content[0].text).toMatch(/chip colours/);

    const forced = await tools.validation.handler({
      spreadsheet_id: SPREADSHEET_ID,
      sheet: VALID_TAB,
      range: "B2:B40",
      type: "list",
      values: ["Confirmed", "Pending", "Declined"],
      force: true,
    });
    expect(isFailure(forced)).toBe(false);
  }, 60_000);

  test("sheets_conditional_format adds, finds by fingerprint, updates and deletes", async () => {
    const added = await tools.cf.handler({
      spreadsheet_id: SPREADSHEET_ID,
      action: "add",
      sheet: CF_TAB,
      ranges: ["A2:A40"],
      operator: "equal",
      value_kind: "text",
      value: "Overdue",
      format: { fill: "flag", strikethrough: true },
    });
    expect(isFailure(added)).toBe(false);
    const fingerprint = (added.structuredContent as Record<string, never>)["fingerprint"] as string;

    // The fingerprint has to survive the round trip: it is computed from what
    // was sent, and re-resolved against what the API hands back, where colours
    // come home as floats.
    const listed = await tools.cf.handler({
      spreadsheet_id: SPREADSHEET_ID,
      action: "list",
      sheet: CF_TAB,
    });
    const rules = (
      (listed.structuredContent as Record<string, never>)["sheets"] as Array<{
        rules: Array<{ fingerprint: string }>;
      }>
    )[0].rules;
    expect(rules.map((r) => r.fingerprint)).toContain(fingerprint);

    const updated = await tools.cf.handler({
      spreadsheet_id: SPREADSHEET_ID,
      action: "update",
      sheet: CF_TAB,
      fingerprint,
      format: { fill: "warn" },
    });
    expect(isFailure(updated)).toBe(false);
    const newFingerprint = (
      (updated.structuredContent as Record<string, never>)["after"] as { fingerprint: string }
    ).fingerprint;
    expect(newFingerprint).not.toBe(fingerprint);

    const deleted = await tools.cf.handler({
      spreadsheet_id: SPREADSHEET_ID,
      action: "delete",
      sheet: CF_TAB,
      fingerprint: newFingerprint,
    });
    expect(isFailure(deleted)).toBe(false);

    const after = await ctx.sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID!,
      fields: "sheets(properties.title,conditionalFormats)",
    });
    const remaining = (after.data.sheets ?? []).find((s) => s.properties?.title === CF_TAB)
      ?.conditionalFormats;
    expect(remaining ?? []).toHaveLength(0);
  }, 90_000);

  test("a stale fingerprint is a refusal that shows what is really there", async () => {
    const result = await tools.cf.handler({
      spreadsheet_id: SPREADSHEET_ID,
      action: "update",
      sheet: CF_TAB,
      fingerprint: fingerprintRule({ ranges: [], booleanRule: { condition: { type: "BLANK" } } }),
      format: { fill: "warn" },
    });
    expect(isFailure(result)).toBe(true);
    expect(result.content[0].text).toMatch(/no conditional format rules|rules on that tab/);
  }, 30_000);
});
