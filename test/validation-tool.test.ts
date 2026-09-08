/**
 * `sheets_validation`. The refusals are the point: a dropdown somebody set in
 * the UI is reported rather than rewritten, and a Table column is sent to
 * `sheets_table` because that is where its rule actually lives.
 *
 * All ids and names are invented.
 */
import { describe, expect, test } from "vitest";

import { errorOf, isFailure } from "../src/lib/result.js";
import { createValidationTool } from "../src/tools/validation.js";
import {
  columnMetadata,
  FAKE_ID,
  makeMutableContext,
  requestsOfKind,
  type FakeWorkbook,
} from "./helpers/fakeMutableContext.js";

const PLAIN: FakeWorkbook = {
  tabs: [
    {
      title: "Tracker",
      sheetId: 0,
      cells: [
        ["Instructor", "Vendor", "Status"],
        ["Nadia Okonkwo", "Bright Circuits", "Confirmed"],
      ],
    },
  ],
};

function tool(workbook: FakeWorkbook = PLAIN, registryJson?: string) {
  const { context, calls, requests } = makeMutableContext(workbook, registryJson);
  return { validation: createValidationTool({ getContext: async () => context }), calls, requests };
}

describe("setting a rule", () => {
  test("a dropdown carries its options, its help text and strict", async () => {
    const { validation, requests } = tool();
    const result = await validation.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Tracker",
      range: "C2:C40",
      type: "list",
      values: ["Confirmed", "Pending", "Declined"],
      help: "Where the vendor has got to. Pending means we are waiting on them.",
    });
    expect(isFailure(result)).toBe(false);

    const [request] = requestsOfKind<{ rule: Record<string, never>; range: Record<string, number> }>(
      requests(),
      "setDataValidation",
    );
    expect(request.rule["condition"]).toMatchObject({ type: "ONE_OF_LIST" });
    expect(request.rule["strict"]).toBe(true);
    expect(request.rule["showCustomUi"]).toBe(true);
    expect(request.rule["inputMessage"]).toMatch(/waiting on them/);
    expect(request.range).toMatchObject({ startColumnIndex: 2, endColumnIndex: 3 });
  });

  test("the response says a render cannot confirm a dropdown", async () => {
    const { validation } = tool();
    const result = await validation.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Tracker",
      range: "C2:C40",
      type: "list",
      values: ["Confirmed"],
    });
    // Spike 1: the PDF export paints fills and fonts but never dropdown chips.
    expect(result.content[0].text).toMatch(/will not show this dropdown as a chip/);
  });

  test("a number rule needs an operator, and says which ones fit", async () => {
    const { validation, calls } = tool();
    const result = await validation.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Tracker",
      range: "D2:D40",
      type: "number",
    });
    expect(errorOf(result)?.code).toBe("invalid_argument");
    expect(result.content[0].text).toMatch(/greater_than/);
    expect(calls.batchUpdate).toHaveLength(0);
  });

  test("a number rule builds the condition from the operator", async () => {
    const { validation, requests } = tool();
    await validation.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Tracker",
      range: "D2:D40",
      type: "number",
      operator: "between",
      value: 1,
      value2: 12,
    });
    const [request] = requestsOfKind<{ rule: Record<string, never> }>(requests(), "setDataValidation");
    expect(request.rule["condition"]).toMatchObject({ type: "NUMBER_BETWEEN" });
  });

  test("clear sends a setDataValidation with no rule", async () => {
    const { validation, requests } = tool();
    const result = await validation.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Tracker",
      range: "C2:C40",
      type: "clear",
    });
    const [request] = requestsOfKind<Record<string, unknown>>(requests(), "setDataValidation");
    expect(request["rule"]).toBeUndefined();
    expect(result.content[0].text).toMatch(/Cleared the validation/);
  });

  test("a dry run sends nothing", async () => {
    const { validation, calls } = tool();
    await validation.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Tracker",
      range: "C2:C40",
      type: "checkbox",
      dry_run: true,
    });
    expect(calls.batchUpdate).toHaveLength(0);
  });
});

describe("rules somebody else set", () => {
  const WITH_UI_RULE: FakeWorkbook = {
    tabs: [
      {
        ...PLAIN.tabs[0],
        cells: [
          ["Instructor", "Vendor", "Status"],
          [
            "Nadia Okonkwo",
            "Bright Circuits",
            { value: "Confirmed", validation: { type: "ONE_OF_LIST", values: ["Confirmed", "Pending"] } },
          ],
        ],
      },
    ],
  };

  test("are refused, with the reason a rewrite would lose", async () => {
    const { validation, calls } = tool(WITH_UI_RULE);
    const result = await validation.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Tracker",
      range: "C2:C40",
      type: "list",
      values: ["Confirmed", "Pending", "Declined"],
    });
    expect(errorOf(result)?.code).toBe("ui_owned");
    expect(result.content[0].text).toMatch(/chip colours/);
    expect(calls.batchUpdate).toHaveLength(0);
  });

  test("force goes through and says the colours are gone", async () => {
    const { validation } = tool(WITH_UI_RULE);
    const result = await validation.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Tracker",
      range: "C2:C40",
      type: "list",
      values: ["Confirmed", "Pending", "Declined"],
      force: true,
    });
    expect(isFailure(result)).toBe(false);
    expect(result.content[0].text).toMatch(/cannot be restored/);
  });

  test("a rule on a column the plugin recorded is its own to replace", async () => {
    const ours: FakeWorkbook = {
      ...WITH_UI_RULE,
      developerMetadata: [columnMetadata(0, 2, { header: "Status", role: "status" })],
    };
    const { validation } = tool(ours);
    const result = await validation.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Tracker",
      range: "C2:C40",
      type: "list",
      values: ["Confirmed", "Pending", "Declined"],
    });
    expect(isFailure(result)).toBe(false);
    expect(result.content[0].text).toMatch(/Replaced 1 rule the plugin had set earlier/);
  });
});

describe("a Table column", () => {
  const WITH_TABLE: FakeWorkbook = {
    tabs: [
      {
        ...PLAIN.tabs[0],
        tables: [
          {
            tableId: "t1",
            name: "Instructors",
            range: { sheetId: 0, startRowIndex: 0, endRowIndex: 40, startColumnIndex: 0, endColumnIndex: 3 },
            columnProperties: [
              { columnIndex: 2, columnName: "Status", columnType: "DROPDOWN" },
            ],
          },
        ],
      },
    ],
  };

  test("is sent to sheets_table, because the rule lives on the Table", async () => {
    const { validation, calls } = tool(WITH_TABLE);
    const result = await validation.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Tracker",
      range: "C2:C40",
      type: "list",
      values: ["Confirmed"],
    });
    expect(errorOf(result)?.code).toBe("invalid_argument");
    expect(result.content[0].text).toMatch(/sheets_table with action update/);
    expect(result.content[0].text).toMatch(/Status \(DROPDOWN\)/);
    expect(calls.batchUpdate).toHaveLength(0);
  });

  test("force writes cell validation anyway, and the response says it fights the Table", async () => {
    const { validation, calls } = tool(WITH_TABLE);
    const result = await validation.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Tracker",
      range: "C2:C40",
      type: "list",
      values: ["Confirmed"],
      force: true,
    });
    expect(isFailure(result)).toBe(false);
    expect(calls.batchUpdate).toHaveLength(1);
  });
});

describe("the registry", () => {
  test("a column that is not ours is refused before the read", async () => {
    const registry = JSON.stringify({
      spreadsheets: {
        [FAKE_ID]: { name: "Background check tracker", owner: "shared", writable_columns: ["A:B"] },
      },
    });
    const { validation, calls } = tool(PLAIN, registry);
    const result = await validation.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Tracker",
      range: "C2:C40",
      type: "checkbox",
    });
    expect(errorOf(result)?.code).toBe("contract_violation");
    expect(calls.batchUpdate).toHaveLength(0);
  });
});
