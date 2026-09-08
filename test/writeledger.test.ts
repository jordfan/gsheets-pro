/**
 * Every tool that changes a spreadsheet records what it touched.
 *
 * Lint rule L14 asks a question no spreadsheet can answer about itself: did
 * *we* put this in a colleague's column, or did they type it? A value sitting
 * there is not evidence either way. The session's write ledger is the only
 * record, so a tool that forgets to call `recordWrite` does not fail, it just
 * makes L14 quietly blind to whatever it did.
 *
 * That is exactly the kind of omission a refactor introduces and no other test
 * notices, which is why each tool gets a case here rather than trusting the
 * call to stay where it was put.
 *
 * All ids and names are invented.
 */
import { beforeEach, describe, expect, test } from "vitest";

import { clearWrites, writesFor } from "../src/lib/writelog.js";
import { isFailure } from "../src/lib/result.js";
import { createBatchTool } from "../src/tools/batch.js";
import { createCheckTool } from "../src/tools/check.js";
import { createConditionalFormatTool } from "../src/tools/conditional_format.js";
import { createSettingsTool } from "../src/tools/settings.js";
import { createStructureTool } from "../src/tools/structure.js";
import { createStyleTool } from "../src/tools/style.js";
import { createTableTool } from "../src/tools/table.js";
import { createValidationTool } from "../src/tools/validation.js";
import { createWriteTool } from "../src/tools/write.js";
import {
  FAKE_ID,
  makeMutableContext,
  type FakeWorkbook,
} from "./helpers/fakeMutableContext.js";
import { makeCheckContext } from "./helpers/fakeCheckContext.js";
import { makeMutationContext, MUT_SPREADSHEET_ID } from "./helpers/fakeMutations.js";
import {
  makeWriteContext,
  WRITE_SPREADSHEET_ID,
  type WriteSpreadsheetSpec,
} from "./helpers/fakeWriteContext.js";

beforeEach(() => {
  clearWrites();
});

/** Every range the ledger holds for a spreadsheet, as one string to match on. */
function ranges(spreadsheetId: string): string {
  return writesFor(spreadsheetId)
    .map((w) => w.range)
    .join(" | ");
}

function toolsUsed(spreadsheetId: string): string[] {
  return [...new Set(writesFor(spreadsheetId).map((w) => w.tool ?? "unnamed"))];
}

// ---------------------------------------------------------------------------
// sheets_write and sheets_style, on the value-writing fake
// ---------------------------------------------------------------------------

const ROSTER: WriteSpreadsheetSpec = {
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
};

describe("sheets_write", () => {
  test("records the range it wrote", async () => {
    const { context } = makeWriteContext(structuredClone(ROSTER));
    const write = createWriteTool({ getContext: async () => context }).handler;

    const response = await write({
      spreadsheet_id: WRITE_SPREADSHEET_ID,
      sheet: "Roster",
      range: "B2:B3",
      values: [["4"], ["5"]],
    });

    expect(isFailure(response)).toBe(false);
    expect(ranges(WRITE_SPREADSHEET_ID)).toContain("B2:B3");
    expect(toolsUsed(WRITE_SPREADSHEET_ID)).toEqual(["sheets_write"]);
    expect(writesFor(WRITE_SPREADSHEET_ID)[0].sheet).toBe("Roster");
  });

  test("records even when the caller turned the check off", async () => {
    const { context } = makeWriteContext(structuredClone(ROSTER));
    const write = createWriteTool({ getContext: async () => context }).handler;

    await write({
      spreadsheet_id: WRITE_SPREADSHEET_ID,
      sheet: "Roster",
      range: "B2",
      values: [["4"]],
      check: false,
    });

    // The gate and the ledger answer different questions. Skipping the read
    // back does not make the write invisible to the lint.
    expect(writesFor(WRITE_SPREADSHEET_ID)).toHaveLength(1);
  });

  test("a dry run records nothing, because nothing was written", async () => {
    const { context } = makeWriteContext(structuredClone(ROSTER));
    const write = createWriteTool({ getContext: async () => context }).handler;

    await write({
      spreadsheet_id: WRITE_SPREADSHEET_ID,
      sheet: "Roster",
      range: "B2",
      values: [["4"]],
      dry_run: true,
    });

    expect(writesFor(WRITE_SPREADSHEET_ID)).toEqual([]);
  });

  test("a refused write records nothing", async () => {
    const withFormula = structuredClone(ROSTER);
    withFormula.tabs[0].formulas = [
      ["Student", "Grade", "Club"],
      ["Ana Reyes", "=1+1", "Clay Studio"],
      ["Bo Tran", "4", "Chess Club"],
    ];
    const { context } = makeWriteContext(withFormula);
    const write = createWriteTool({ getContext: async () => context }).handler;

    const response = await write({
      spreadsheet_id: WRITE_SPREADSHEET_ID,
      sheet: "Roster",
      range: "B2",
      values: [["4"]],
    });

    expect(isFailure(response)).toBe(true);
    expect(writesFor(WRITE_SPREADSHEET_ID)).toEqual([]);
  });
});

describe("sheets_style", () => {
  test("records the styled range, because formatting a column is touching it", async () => {
    const { context } = makeWriteContext(structuredClone(ROSTER));
    const style = createStyleTool({ getContext: async () => context }).handler;

    const response = await style({
      spreadsheet_id: WRITE_SPREADSHEET_ID,
      sheet: "Roster",
      range: "A1:C1",
      style: { bold: true },
    });

    expect(isFailure(response)).toBe(false);
    expect(ranges(WRITE_SPREADSHEET_ID)).toContain("A1:C1");
    expect(toolsUsed(WRITE_SPREADSHEET_ID)).toEqual(["sheets_style"]);
  });
});

// ---------------------------------------------------------------------------
// The four Phase 3 tools, on the mutable fake
// ---------------------------------------------------------------------------

const INSTRUCTORS: FakeWorkbook = {
  title: "Fall roster",
  tabs: [
    {
      title: "Tracker",
      sheetId: 0,
      cells: [
        ["Instructor", "Vendor", "Status", "Sessions", "Fee"],
        ["Nadia Okonkwo", "Bright Circuits", "Confirmed", "8", "440"],
        ["Emil Sandoval", "Bright Circuits", "Pending", "8", "440"],
      ],
    },
  ],
};

function mutableTool<T>(factory: (deps: { getContext: () => Promise<never> }) => T): T {
  const { context } = makeMutableContext(structuredClone(INSTRUCTORS));
  return factory({ getContext: async () => context as never });
}

describe("sheets_table", () => {
  test("records the block it turned into a Table", async () => {
    const table = mutableTool(createTableTool);

    const response = await table.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Tracker",
      action: "create",
      range: "A1:E3",
      name: "Instructors",
    });

    expect(isFailure(response)).toBe(false);
    expect(ranges(FAKE_ID)).toContain("A1:E3");
    expect(toolsUsed(FAKE_ID)).toEqual(["sheets_table"]);
  });
});

describe("sheets_settings", () => {
  test("records the value column it wrote", async () => {
    const settings = mutableTool(createSettingsTool);

    const response = await settings.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Tracker",
      items: [{ label: "Fee per session", value: 55, unit: "dollars" }],
    });

    expect(isFailure(response)).toBe(false);
    expect(writesFor(FAKE_ID).length).toBeGreaterThan(0);
    expect(toolsUsed(FAKE_ID)).toEqual(["sheets_settings"]);
  });
});

describe("sheets_validation", () => {
  test("records the range whose allowed values it changed", async () => {
    const validation = mutableTool(createValidationTool);

    const response = await validation.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Tracker",
      range: "C2:C3",
      type: "list",
      values: ["Confirmed", "Pending"],
    });

    expect(isFailure(response)).toBe(false);
    expect(ranges(FAKE_ID)).toContain("C2:C3");
    expect(toolsUsed(FAKE_ID)).toEqual(["sheets_validation"]);
  });
});

describe("sheets_conditional_format", () => {
  test("records the ranges the rule paints", async () => {
    const cf = mutableTool(createConditionalFormatTool);

    const response = await cf.handler({
      spreadsheet_id: FAKE_ID,
      sheet: "Tracker",
      action: "add",
      ranges: ["C2:C200"],
      operator: "equal",
      value_kind: "text",
      value: "Pending",
      format: { fill: "warn" },
    });

    expect(isFailure(response)).toBe(false);
    expect(ranges(FAKE_ID)).toContain("C2:C200");
    expect(toolsUsed(FAKE_ID)).toEqual(["sheets_conditional_format"]);
  });
});

// ---------------------------------------------------------------------------
// sheets_structure and sheets_batch, on the mutations fake
// ---------------------------------------------------------------------------

describe("sheets_structure", () => {
  test("records what a sort rewrote", async () => {
    const { context } = makeMutationContext({
      title: "Fall Enrichment",
      tabs: [
        {
          title: "Roster",
          sheetId: 0,
          frozenRowCount: 1,
          headers: ["Student", "Grade", "Class"],
        },
      ],
    });
    const structure = createStructureTool({ getContext: async () => context }).handler;

    const response = await structure({
      spreadsheet_id: MUT_SPREADSHEET_ID,
      action: "sort",
      sheet: "Roster",
      sort_by: [{ column: "Grade" }],
    });

    expect(isFailure(response)).toBe(false);
    expect(writesFor(MUT_SPREADSHEET_ID).length).toBeGreaterThan(0);
    expect(toolsUsed(MUT_SPREADSHEET_ID)).toEqual(["sheets_structure"]);
  });
});

describe("sheets_batch", () => {
  test("records what the escape hatch touched, which is the only record there is", async () => {
    const { context } = makeMutationContext({
      title: "Fall Enrichment",
      tabs: [
        {
          title: "Roster",
          sheetId: 0,
          frozenRowCount: 1,
          headers: ["Student", "Grade", "Class"],
        },
      ],
    });
    const batch = createBatchTool({ getContext: async () => context }).handler;

    const response = await batch({
      spreadsheet_id: MUT_SPREADSHEET_ID,
      requests: [
        { sortRange: { range: "'Roster'!A2:C80", sortSpecs: [{ dimensionIndex: 1 }] } },
      ],
    });

    expect(isFailure(response)).toBe(false);
    expect(writesFor(MUT_SPREADSHEET_ID).length).toBeGreaterThan(0);
    expect(toolsUsed(MUT_SPREADSHEET_ID)).toEqual(["sheets_batch"]);
  });
});

// ---------------------------------------------------------------------------
// The seam: a real tool's record, read by the real rule
// ---------------------------------------------------------------------------

describe("the ledger and sheets_check, end to end", () => {
  test("a forced write into a reserved column raises L14 with no writes argument", async () => {
    // The registry reserves C for a person. Both tools are pointed at the same
    // spreadsheet id and tab, because that pair is what the ledger is keyed on.
    const entry = { name: "Autumn Clubs", owner: "shared", writable_columns: ["A", "B"] };
    const registry = JSON.stringify({ spreadsheets: { [WRITE_SPREADSHEET_ID]: entry } });

    const { context } = makeWriteContext(structuredClone(ROSTER), registry);
    const write = createWriteTool({ getContext: async () => context }).handler;

    const written = await write({
      spreadsheet_id: WRITE_SPREADSHEET_ID,
      sheet: "Roster",
      range: "C2",
      values: [["Chess Club"]],
      force: true,
    });
    expect(isFailure(written)).toBe(false);

    // Nothing is handed across. sheets_check is given a spreadsheet id and a
    // registry, and has to find the write in the ledger by itself, which is
    // the whole point of the ledger existing.
    const checkContext = makeCheckContext(
      [
        {
          title: "Roster",
          sheetId: 0,
          frozenRows: 1,
          rows: [
            ["Student", "Grade", "Club"],
            ["Ana Reyes", "3", "Chess Club"],
          ],
        },
      ],
      { registryJson: registry },
    ).context;
    const check = createCheckTool({ getContext: async () => checkContext }).handler;

    const response = await check({ spreadsheet_id: WRITE_SPREADSHEET_ID });
    expect(isFailure(response)).toBe(false);

    const body = response.structuredContent as {
      findings: Array<{ rule: string; severity: string; location: string; message: string }>;
    };
    const l14 = body.findings.filter((f) => f.rule === "L14");
    expect(l14).toHaveLength(1);
    expect(l14[0].severity).toBe("warning");
    expect(l14[0].location).toContain("C2");
    expect(l14[0].message).toContain("Club");
  });

  test("the same check is clean when the write stayed inside our columns", async () => {
    const entry = { name: "Autumn Clubs", owner: "shared", writable_columns: ["A", "B"] };
    const registry = JSON.stringify({ spreadsheets: { [WRITE_SPREADSHEET_ID]: entry } });

    const { context } = makeWriteContext(structuredClone(ROSTER), registry);
    const write = createWriteTool({ getContext: async () => context }).handler;

    await write({
      spreadsheet_id: WRITE_SPREADSHEET_ID,
      sheet: "Roster",
      range: "B2",
      values: [["4"]],
    });

    const checkContext = makeCheckContext(
      [
        {
          title: "Roster",
          sheetId: 0,
          frozenRows: 1,
          rows: [
            ["Student", "Grade", "Club"],
            ["Ana Reyes", "4", "Clay Studio"],
          ],
        },
      ],
      { registryJson: registry },
    ).context;
    const check = createCheckTool({ getContext: async () => checkContext }).handler;

    const response = await check({ spreadsheet_id: WRITE_SPREADSHEET_ID });
    const body = response.structuredContent as { findings: Array<{ rule: string }> };
    expect(body.findings.filter((f) => f.rule === "L14")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The property that matters across all of them
// ---------------------------------------------------------------------------

describe("all eight tools", () => {
  test("name themselves, so a finding can say which call did it", async () => {
    const { context } = makeWriteContext(structuredClone(ROSTER));
    const write = createWriteTool({ getContext: async () => context }).handler;
    const style = createStyleTool({ getContext: async () => context }).handler;

    await write({
      spreadsheet_id: WRITE_SPREADSHEET_ID,
      sheet: "Roster",
      range: "B2",
      values: [["4"]],
    });
    await style({
      spreadsheet_id: WRITE_SPREADSHEET_ID,
      sheet: "Roster",
      range: "A1:C1",
      style: { bold: true },
    });

    expect(toolsUsed(WRITE_SPREADSHEET_ID).sort()).toEqual(["sheets_style", "sheets_write"]);
    for (const record of writesFor(WRITE_SPREADSHEET_ID)) {
      expect(record.tool).toMatch(/^sheets_/);
      expect(record.range).toBeTruthy();
    }
  });
});
