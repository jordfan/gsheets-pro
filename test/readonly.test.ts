/**
 * `read_only`: a registry entry saying nothing here is ours to change.
 *
 * The cutover found the gap this closes. An absent or empty `writable_columns`
 * reads as "no restriction stated", so it says nothing at all, and there was
 * no way to write down "never write here" for a reference sheet of term dates
 * or a finished historical tab. The two are different statements and the tests
 * that matter are the ones holding them apart.
 *
 * The other half is reach. `writable_columns` can only speak for tools that
 * look at a column, and most of them never do: a banding, a sort, a Table, a
 * raw batchUpdate. `read_only` has to stop those too.
 *
 * All ids and names are invented.
 */
import { beforeEach, describe, expect, test } from "vitest";

import { assertWritable, isColumnWritable, parseRegistry } from "../src/lib/registry.js";
import { errorOf, isFailure } from "../src/lib/result.js";
import { clearWrites, writesFor } from "../src/lib/writelog.js";
import { createBatchTool } from "../src/tools/batch.js";
import { createConditionalFormatTool } from "../src/tools/conditional_format.js";
import { createSettingsTool } from "../src/tools/settings.js";
import { createStructureTool } from "../src/tools/structure.js";
import { createStyleTool } from "../src/tools/style.js";
import { createTableTool } from "../src/tools/table.js";
import { createValidationTool } from "../src/tools/validation.js";
import { createWriteTool } from "../src/tools/write.js";
import { FAKE_ID, makeMutableContext, type FakeWorkbook } from "./helpers/fakeMutableContext.js";
import { makeMutationContext, MUT_SPREADSHEET_ID } from "./helpers/fakeMutations.js";
import {
  makeWriteContext,
  WRITE_SPREADSHEET_ID,
  type WriteSpreadsheetSpec,
} from "./helpers/fakeWriteContext.js";

beforeEach(() => {
  clearWrites();
});

const readOnlyFor = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    spreadsheets: {
      [id]: { name: "Term Dates", owner: "human", read_only: true, ...extra },
    },
  });

// ---------------------------------------------------------------------------
// The policy itself
// ---------------------------------------------------------------------------

describe("the registry field", () => {
  const policyOf = (json: string, sheet?: string) =>
    parseRegistry(json, "test/.claude/gsheets-pro.json").policyFor(FAKE_ID, sheet);

  test("read_only reaches the resolved policy", () => {
    expect(policyOf(readOnlyFor(FAKE_ID))?.readOnly).toBe(true);
  });

  test("a spreadsheet without it is not read only", () => {
    const json = JSON.stringify({ spreadsheets: { [FAKE_ID]: { owner: "shared" } } });
    expect(policyOf(json)?.readOnly).toBe(false);
  });

  test("it can be set on one tab of an otherwise writable workbook", () => {
    const json = JSON.stringify({
      spreadsheets: {
        [FAKE_ID]: {
          owner: "shared",
          sheets: { Archive: { read_only: true } },
        },
      },
    });
    expect(policyOf(json, "Working")?.readOnly).toBe(false);
    expect(policyOf(json, "Archive")?.readOnly).toBe(true);
  });

  test("it can be set for every spreadsheet in the file at once", () => {
    const json = JSON.stringify({
      defaults: { read_only: true },
      spreadsheets: { [FAKE_ID]: { owner: "human" } },
    });
    expect(policyOf(json)?.readOnly).toBe(true);
  });
});

describe("read_only against writable_columns", () => {
  const policyOf = (entry: Record<string, unknown>) =>
    parseRegistry(JSON.stringify({ spreadsheets: { [FAKE_ID]: entry } }), "test/reg.json").policyFor(
      FAKE_ID,
    );

  test("an empty writable_columns still permits everything, which is the gap", () => {
    const policy = policyOf({ owner: "human", writable_columns: [] });
    expect(isColumnWritable(policy, { letter: "A" }).writable).toBe(true);
  });

  test("read_only refuses the same column, with a reason that says why", () => {
    const policy = policyOf({ owner: "human", read_only: true });
    const verdict = isColumnWritable(policy, { letter: "A" });
    expect(verdict.writable).toBe(false);
    expect(verdict.reason).toContain("read only");
  });

  test("read_only outranks a column list that would have allowed the write", () => {
    const policy = policyOf({ owner: "human", read_only: true, writable_columns: ["A:Z"] });
    expect(isColumnWritable(policy, { letter: "C" }).writable).toBe(false);
  });

  test("assertWritable throws for a read-only sheet and is silent otherwise", () => {
    const locked = policyOf({ owner: "human", read_only: true });
    const open = policyOf({ owner: "human" });

    expect(() => assertWritable(open, { tool: "sheets_write" })).not.toThrow();
    try {
      assertWritable(locked, { tool: "sheets_write" });
      throw new Error("should have refused");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("contract_violation");
      expect((error as Error).message).toContain("sheets_write");
      expect((error as { hint?: string }).hint).toContain("fix the registry");
    }
  });

  test("force is the way past it", () => {
    const locked = policyOf({ owner: "human", read_only: true });
    expect(() => assertWritable(locked, { tool: "sheets_write", force: true })).not.toThrow();
  });

  test("the reason carries the note, because that is where the why lives", () => {
    const locked = policyOf({
      owner: "human",
      read_only: true,
      note: "The calendar everything else quotes.",
    });
    try {
      assertWritable(locked, { tool: "sheets_style" });
    } catch (error) {
      expect((error as Error).message).toContain("The calendar everything else quotes.");
    }
  });
});

// ---------------------------------------------------------------------------
// Every writing tool refuses
// ---------------------------------------------------------------------------

const ROSTER: WriteSpreadsheetSpec = {
  title: "Term Dates",
  tabs: [
    {
      title: "Roster",
      sheetId: 0,
      frozenRowCount: 1,
      values: [
        ["Student", "Grade", "Club"],
        ["Ana Reyes", "3", "Clay Studio"],
      ],
    },
  ],
};

const WORKBOOK: FakeWorkbook = {
  title: "Term Dates",
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

describe("the eight writing tools", () => {
  test("sheets_write refuses", async () => {
    const { context } = makeWriteContext(structuredClone(ROSTER), readOnlyFor(WRITE_SPREADSHEET_ID));
    const write = createWriteTool({ getContext: async () => context }).handler;
    const response = await write({
      spreadsheet_id: WRITE_SPREADSHEET_ID,
      sheet: "Roster",
      range: "A2",
      values: [["Bo Tran"]],
    });

    expect(errorOf(response)?.code).toBe("contract_violation");
    expect(errorOf(response)?.message).toContain("read only");
    expect(writesFor(WRITE_SPREADSHEET_ID)).toEqual([]);
  });

  test("sheets_style refuses, though it never looks at a column", async () => {
    const { context, calls } = makeWriteContext(
      structuredClone(ROSTER),
      readOnlyFor(WRITE_SPREADSHEET_ID),
    );
    const style = createStyleTool({ getContext: async () => context }).handler;
    const response = await style({
      spreadsheet_id: WRITE_SPREADSHEET_ID,
      sheet: "Roster",
      range: "A1:C1",
      style: { bold: true },
    });

    expect(errorOf(response)?.message).toContain("read only");
    expect(calls.batchUpdate).toHaveLength(0);
  });

  test("sheets_table refuses", async () => {
    const { context } = makeMutableContext(structuredClone(WORKBOOK), readOnlyFor(FAKE_ID));
    const table = createTableTool({ getContext: async () => context }).handler;
    const response = await table({
      spreadsheet_id: FAKE_ID,
      sheet: "Tracker",
      action: "create",
      range: "A1:C2",
      name: "Instructors",
    });
    expect(errorOf(response)?.message).toContain("read only");
  });

  test("sheets_settings refuses", async () => {
    const { context } = makeMutableContext(structuredClone(WORKBOOK), readOnlyFor(FAKE_ID));
    const settings = createSettingsTool({ getContext: async () => context }).handler;
    const response = await settings({
      spreadsheet_id: FAKE_ID,
      sheet: "Tracker",
      items: [{ label: "Fee per session", value: 55 }],
    });
    expect(errorOf(response)?.message).toContain("read only");
  });

  test("sheets_validation refuses", async () => {
    const { context } = makeMutableContext(structuredClone(WORKBOOK), readOnlyFor(FAKE_ID));
    const validation = createValidationTool({ getContext: async () => context }).handler;
    const response = await validation({
      spreadsheet_id: FAKE_ID,
      sheet: "Tracker",
      range: "C2:C9",
      type: "list",
      values: ["Confirmed", "Pending"],
    });
    expect(errorOf(response)?.message).toContain("read only");
  });

  test("sheets_conditional_format refuses to add, but still lists", async () => {
    const { context } = makeMutableContext(structuredClone(WORKBOOK), readOnlyFor(FAKE_ID));
    const cf = createConditionalFormatTool({ getContext: async () => context }).handler;

    const added = await cf({
      spreadsheet_id: FAKE_ID,
      sheet: "Tracker",
      action: "add",
      ranges: ["C2:C9"],
      operator: "equal",
      value_kind: "text",
      value: "Pending",
      format: { fill: "warn" },
    });
    expect(errorOf(added)?.message).toContain("read only");

    // Reading a read-only sheet is the entire point of a read-only sheet.
    const listed = await cf({ spreadsheet_id: FAKE_ID, action: "list" });
    expect(isFailure(listed)).toBe(false);
  });

  test("sheets_structure refuses", async () => {
    const { context } = makeMutationContext(
      {
        title: "Term Dates",
        tabs: [{ title: "Roster", sheetId: 0, frozenRowCount: 1, headers: ["Student", "Grade"] }],
      },
      { registryJson: readOnlyFor(MUT_SPREADSHEET_ID) },
    );
    const structure = createStructureTool({ getContext: async () => context }).handler;
    const response = await structure({
      spreadsheet_id: MUT_SPREADSHEET_ID,
      action: "sort",
      sheet: "Roster",
      sort_by: [{ column: "Grade" }],
    });
    expect(errorOf(response)?.message).toContain("read only");
  });

  test("sheets_batch refuses, so the escape hatch is not one", async () => {
    const { context, calls } = makeMutationContext(
      {
        title: "Term Dates",
        tabs: [{ title: "Roster", sheetId: 0, frozenRowCount: 1, headers: ["Student", "Grade"] }],
      },
      { registryJson: readOnlyFor(MUT_SPREADSHEET_ID) },
    );
    const batch = createBatchTool({ getContext: async () => context }).handler;
    const response = await batch({
      spreadsheet_id: MUT_SPREADSHEET_ID,
      requests: [{ sortRange: { range: "'Roster'!A2:B80", sortSpecs: [{ dimensionIndex: 1 }] } }],
    });

    expect(errorOf(response)?.message).toContain("read only");
    expect(calls.batchUpdate).toHaveLength(0);
  });
});

describe("force, and the sheets that are not read only", () => {
  test("force lets the write through and it lands", async () => {
    const { context, tabs } = makeWriteContext(
      structuredClone(ROSTER),
      readOnlyFor(WRITE_SPREADSHEET_ID),
    );
    const write = createWriteTool({ getContext: async () => context }).handler;
    const response = await write({
      spreadsheet_id: WRITE_SPREADSHEET_ID,
      sheet: "Roster",
      range: "A2",
      values: [["Bo Tran"]],
      force: true,
    });

    expect(isFailure(response)).toBe(false);
    expect(tabs.get("roster")!.grid[1][0]).toBe("Bo Tran");
  });

  test("a spreadsheet the registry does not mark is untouched by any of this", async () => {
    const other = JSON.stringify({
      spreadsheets: { [WRITE_SPREADSHEET_ID]: { owner: "shared" } },
    });
    const { context } = makeWriteContext(structuredClone(ROSTER), other);
    const write = createWriteTool({ getContext: async () => context }).handler;
    const response = await write({
      spreadsheet_id: WRITE_SPREADSHEET_ID,
      sheet: "Roster",
      range: "A2",
      values: [["Bo Tran"]],
    });
    expect(isFailure(response)).toBe(false);
  });

  test("a read-only tab does not lock the rest of the workbook", async () => {
    const perTab = JSON.stringify({
      spreadsheets: {
        [WRITE_SPREADSHEET_ID]: { owner: "shared", sheets: { Archive: { read_only: true } } },
      },
    });
    const { context } = makeWriteContext(structuredClone(ROSTER), perTab);
    const write = createWriteTool({ getContext: async () => context }).handler;
    const response = await write({
      spreadsheet_id: WRITE_SPREADSHEET_ID,
      sheet: "Roster",
      range: "A2",
      values: [["Bo Tran"]],
    });
    expect(isFailure(response)).toBe(false);
  });
});
