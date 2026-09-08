/**
 * `sheets_write` against a Sheets client that can actually be written to.
 *
 * The tests that matter most are the refusals. A tool that writes correctly
 * ninety-five percent of the time and silently replaces a formula the other
 * five is worse than one that refuses, because nobody finds out until the
 * numbers are wrong.
 *
 * Every name, id and email in here is invented.
 */
import { describe, expect, test } from "vitest";

import { errorOf, isFailure } from "../src/lib/result.js";
import { createWriteTool } from "../src/tools/write.js";
import { coalesce, findBlocks, resolveColumn, resolveHeaderRow } from "../src/tools/write.js";
import {
  makeWriteContext,
  WRITE_SPREADSHEET_ID,
  type WriteSpreadsheetSpec,
} from "./helpers/fakeWriteContext.js";

const ROSTER: WriteSpreadsheetSpec = {
  title: "Autumn Clubs",
  tabs: [
    {
      title: "Roster",
      sheetId: 0,
      frozenRowCount: 1,
      values: [
        ["Student", "Grade", "Club", "Sessions", "Fee"],
        ["Ana Reyes", "3", "Clay Studio", "8", "440"],
        ["Bo Tran", "4", "Chess Club", "8", "440"],
      ],
      formulas: [
        ["Student", "Grade", "Club", "Sessions", "Fee"],
        ["Ana Reyes", "3", "Clay Studio", "8", "=D2*55"],
        ["Bo Tran", "4", "Chess Club", "8", "=D3*55"],
      ],
    },
  ],
};

const SHARED_REGISTRY = JSON.stringify({
  spreadsheets: {
    [WRITE_SPREADSHEET_ID]: {
      name: "Autumn Clubs",
      owner: "shared",
      writable_columns: ["A:C"],
      colleague_safe_text: true,
    },
  },
});

function tool(spec: WriteSpreadsheetSpec = ROSTER, registry?: string) {
  const fake = makeWriteContext(structuredClone(spec), registry);
  const definition = createWriteTool({ getContext: async () => fake.context });
  return { ...fake, run: definition.handler, definition };
}

const base = { spreadsheet_id: WRITE_SPREADSHEET_ID, sheet: "Roster" };

describe("mode range", () => {
  test("writes the block and reads it back through the gate", async () => {
    const { run, calls, tabs } = tool();
    const response = await run({ ...base, range: "B2:B3", values: [["4"], ["5"]] });

    expect(isFailure(response)).toBe(false);
    expect(calls.valuesBatchUpdate).toHaveLength(1);
    expect(tabs.get("roster")!.grid[1][1]).toBe("4");
    const structured = response.structuredContent as { check: { status: string } };
    expect(structured.check.status).toBe("ok");
  });

  test("USER_ENTERED is the default, so a formula stays a formula", async () => {
    const { run, calls } = tool();
    await run({ ...base, range: "C2", values: [["Clay Studio"]] });
    const body = calls.valuesBatchUpdate[0]["requestBody"] as { valueInputOption: string };
    expect(body.valueInputOption).toBe("USER_ENTERED");
  });

  test("raw writes everything literally", async () => {
    const { run, calls } = tool();
    await run({ ...base, range: "C2", values: [["=not a formula"]], raw: true });
    const body = calls.valuesBatchUpdate[0]["requestBody"] as { valueInputOption: string };
    expect(body.valueInputOption).toBe("RAW");
  });

  test("records land in the columns their headers name", async () => {
    const { run, tabs } = tool();
    await run({ ...base, range: "A4", records: [{ Student: "Cy Okafor", Club: "Chess Club" }] });
    const grid = tabs.get("roster")!.grid;
    expect(grid[3][0]).toBe("Cy Okafor");
    expect(grid[3][2]).toBe("Chess Club");
  });

  test("a range write with nothing in it is refused rather than sent", async () => {
    const { run } = tool();
    const response = await run({ ...base, range: "B2" });
    expect(errorOf(response)?.message).toContain("Nothing to write");
  });
});

describe("the formula guard", () => {
  test("refuses to replace a formula, and names the cell and the formula", async () => {
    const { run, calls } = tool();
    const response = await run({ ...base, range: "E2:E3", values: [["500"], ["500"]] });

    expect(isFailure(response)).toBe(true);
    const error = errorOf(response)!;
    expect(error.code).toBe("formula_guard");
    expect(error.message).toContain("E2");
    expect(error.message).toContain("=D2*55");
    expect(error.hint).toContain("force");
    expect(calls.valuesBatchUpdate).toHaveLength(0);
  });

  test("force writes anyway and says in the response that it did", async () => {
    const { run, calls } = tool();
    const response = await run({ ...base, range: "E2:E3", values: [["500"], ["500"]], force: true });

    expect(isFailure(response)).toBe(false);
    expect(calls.valuesBatchUpdate).toHaveLength(1);
    const warnings = (response.structuredContent as { warnings: string[] }).warnings;
    expect(warnings.join(" ")).toContain("force was passed");
  });

  test("writing a formula back byte for byte is not a collision", async () => {
    const { run, calls } = tool();
    const response = await run({ ...base, range: "E2", values: [["=D2*55"]] });
    expect(isFailure(response)).toBe(false);
    expect(calls.valuesBatchUpdate).toHaveLength(1);
  });

  test("a cell with no incoming value is not a collision either", async () => {
    const { run } = tool();
    // B2:C2 covers no formula; E is left alone entirely.
    const response = await run({ ...base, range: "B2:C2", values: [["4", "Clay Studio"]] });
    expect(isFailure(response)).toBe(false);
  });
});

describe("the contract", () => {
  test("a column outside writable_columns is refused, naming the registry", async () => {
    const { run } = tool(ROSTER, SHARED_REGISTRY);
    const response = await run({ ...base, range: "D2", values: [["9"]] });

    const error = errorOf(response)!;
    expect(error.code).toBe("contract_violation");
    expect(error.message).toContain("A:C");
    expect(error.hint).toContain("fix the registry");
  });

  test("a column inside writable_columns goes through", async () => {
    const { run } = tool(ROSTER, SHARED_REGISTRY);
    const response = await run({ ...base, range: "B2", values: [["4"]] });
    expect(isFailure(response)).toBe(false);
  });

  test("a column the sheet's own metadata marks human owned is refused", async () => {
    const spec = structuredClone(ROSTER);
    const { run } = tool(
      {
        ...spec,
        developerMetadata: [
          {
            metadataKey: "gsheets.column",
            metadataValue: JSON.stringify({ name: "sessions", header: "Sessions", owner: "human" }),
            location: { dimensionRange: { sheetId: 0, dimension: "COLUMNS", startIndex: 3 } },
          },
        ],
      },
      undefined,
    );
    const response = await run({ ...base, range: "D2", values: [["9"]] });
    expect(errorOf(response)?.message).toContain("human owned");
  });

  test("expect_contract refuses when the headers moved under the plan", async () => {
    const { run } = tool();
    const response = await run({
      ...base,
      range: "B2",
      values: [["4"]],
      expect_contract: { headers: ["Student", "Grade", "Club", "Sessions", "Notes"] },
    });
    const error = errorOf(response)!;
    expect(error.code).toBe("contract_violation");
    expect(error.message).toContain("header row now reads");
    expect(error.hint).toContain("sheets_open");
  });

  test("expect_contract that matches is silent", async () => {
    const { run } = tool();
    const response = await run({
      ...base,
      range: "B2",
      values: [["4"]],
      expect_contract: { headers: ["Student", "Grade", "Club", "Sessions", "Fee"], source: "none" },
    });
    expect(isFailure(response)).toBe(false);
  });
});

describe("the colleague-safe check", () => {
  test("refuses a task marker on a shared sheet", async () => {
    const { run } = tool(ROSTER, SHARED_REGISTRY);
    const response = await run({ ...base, range: "C2", values: [["TODO: confirm with the vendor"]] });

    const error = errorOf(response)!;
    expect(error.code).toBe("contract_violation");
    expect(error.message).toContain("would not read as a colleague's");
    expect(error.hint).toContain("allowlist");
  });

  test("the same text on a sheet nobody shares is fine", async () => {
    const { run } = tool();
    const response = await run({ ...base, range: "C2", values: [["TODO: confirm with the vendor"]] });
    expect(isFailure(response)).toBe(false);
  });

  test("a heuristic match warns rather than refusing", async () => {
    const { run } = tool(ROSTER, SHARED_REGISTRY);
    const response = await run({ ...base, range: "C2", values: [["2026-09-07T03:00:00Z"]] });
    expect(isFailure(response)).toBe(false);
    expect((response.structuredContent as { warnings: string[] }).warnings.join(" ")).toContain(
      "bare_timestamp",
    );
  });

  test("an allowlisted phrase goes through", async () => {
    const registry = JSON.stringify({
      spreadsheets: {
        [WRITE_SPREADSHEET_ID]: { owner: "shared", colleague_safe_text: true, allowlist: ["TODO:"] },
      },
    });
    const { run } = tool(ROSTER, registry);
    const response = await run({ ...base, range: "C2", values: [["TODO: confirm with the vendor"]] });
    expect(isFailure(response)).toBe(false);
  });
});

describe("mode append", () => {
  test("lands straight after the last row of data", async () => {
    const { run, tabs } = tool();
    await run({ ...base, mode: "append", records: [{ Student: "Cy Okafor", Grade: "5" }] });
    const grid = tabs.get("roster")!.grid;
    expect(grid[3][0]).toBe("Cy Okafor");
    expect(grid[3][1]).toBe("5");
  });

  test("a tab holding two blocks is refused rather than guessed at", async () => {
    const twoBlocks: WriteSpreadsheetSpec = {
      title: "Autumn Clubs",
      tabs: [
        {
          title: "Roster",
          sheetId: 0,
          frozenRowCount: 1,
          values: [
            ["Student", "Grade"],
            ["Ana Reyes", "3"],
            ["Bo Tran", "4"],
            ["", ""],
            ["Totals", "2"],
          ],
        },
      ],
    };
    const { run, calls } = tool(twoBlocks);
    const response = await run({ ...base, mode: "append", values: [["Cy Okafor", "5"]] });

    const error = errorOf(response)!;
    expect(error.message).toContain("more than one block");
    expect(error.hint).toContain("row 3");
    expect(calls.valuesBatchUpdate).toHaveLength(0);
  });

  test("at_row overrides the guess and writes exactly there", async () => {
    const { run, tabs } = tool();
    await run({ ...base, mode: "append", at_row: 10, values: [["Cy Okafor", "5"]] });
    expect(tabs.get("roster")!.grid[9][0]).toBe("Cy Okafor");
  });

  test("a Table is appended with values.append and INSERT_ROWS, never appendCells", async () => {
    const withTable: WriteSpreadsheetSpec = {
      title: "Autumn Clubs",
      tabs: [
        {
          ...ROSTER.tabs[0],
          tables: [
            {
              tableId: "t1",
              name: "Enrolment",
              range: { sheetId: 0, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 5 },
              columnProperties: [
                { columnIndex: 0, columnName: "Student", columnType: "TEXT" },
                { columnIndex: 1, columnName: "Grade", columnType: "TEXT" },
                { columnIndex: 2, columnName: "Club", columnType: "TEXT" },
                { columnIndex: 3, columnName: "Sessions", columnType: "DOUBLE" },
                { columnIndex: 4, columnName: "Fee", columnType: "CURRENCY" },
              ],
            },
          ],
        },
      ],
    };
    const { run, calls } = tool(withTable);
    const response = await run({
      ...base,
      mode: "append",
      records: [{ Student: "Cy Okafor", Grade: "5", Club: "Chess Club" }],
    });

    expect(isFailure(response)).toBe(false);
    expect(calls.valuesAppend).toHaveLength(1);
    expect(calls.valuesAppend[0]["insertDataOption"]).toBe("INSERT_ROWS");
    expect(String(calls.valuesAppend[0]["range"])).toContain("Roster");
    expect(JSON.stringify(calls.batchUpdate)).not.toContain("appendCells");
  });

  test("a Table with a TEXT column gets a RAW correction pass once the rows land", async () => {
    const withTable: WriteSpreadsheetSpec = {
      title: "Autumn Clubs",
      tabs: [
        {
          ...ROSTER.tabs[0],
          tables: [
            {
              tableId: "t1",
              range: { sheetId: 0, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 5 },
              columnProperties: [
                { columnIndex: 0, columnName: "Student", columnType: "TEXT" },
                { columnIndex: 3, columnName: "Sessions", columnType: "DOUBLE" },
              ],
            },
          ],
        },
      ],
    };
    const { run, calls } = tool(withTable);
    await run({ ...base, mode: "append", values: [["Cy Okafor", "5", "Chess Club", "8", "440"]] });

    expect(calls.valuesAppend).toHaveLength(1);
    expect(calls.valuesAppend[0]["valueInputOption"]).toBe("USER_ENTERED");
    const correction = calls.valuesBatchUpdate.find(
      (c) => (c["requestBody"] as { valueInputOption: string }).valueInputOption === "RAW",
    );
    expect(correction).toBeDefined();
  });
});

describe("mode log", () => {
  test("stamps today's date into the date column", async () => {
    const logTab: WriteSpreadsheetSpec = {
      title: "Autumn Clubs",
      tabs: [
        {
          title: "Roster",
          sheetId: 0,
          frozenRowCount: 1,
          values: [
            ["Date", "What happened"],
            ["2026-09-01", "Registration opened"],
          ],
        },
      ],
    };
    const { run, tabs } = tool(logTab);
    await run({ ...base, mode: "log", values: [["", "Waitlist cleared"]] });
    const row = tabs.get("roster")!.grid[2];
    expect(String(row[0])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row[1]).toBe("Waitlist cleared");
  });

  test("a date the caller supplied is left alone", async () => {
    const logTab: WriteSpreadsheetSpec = {
      title: "Autumn Clubs",
      tabs: [
        { title: "Roster", sheetId: 0, frozenRowCount: 1, values: [["Date", "What happened"]] },
      ],
    };
    const { run, tabs } = tool(logTab);
    await run({ ...base, mode: "log", values: [["2026-08-14", "Backdated"]] });
    expect(tabs.get("roster")!.grid[1][0]).toBe("2026-08-14");
  });
});

describe("mode upsert", () => {
  test("the batch form resolves every key from one read and writes once", async () => {
    const { run, calls, tabs } = tool();
    const response = await run({
      ...base,
      mode: "upsert",
      key_column: "Student",
      rows: [
        { key: "Ana Reyes", set: { Club: "Chess Club" } },
        { key: "Bo Tran", set: { Grade: "5" } },
      ],
    });

    expect(isFailure(response)).toBe(false);
    expect(calls.valuesBatchUpdate).toHaveLength(1);
    const grid = tabs.get("roster")!.grid;
    expect(grid[1][2]).toBe("Chess Club");
    expect(grid[2][1]).toBe("5");
    const structured = response.structuredContent as { matched: number; inserted: number };
    expect(structured).toMatchObject({ matched: 2, inserted: 0 });
  });

  test("only the named fields change, and the rest of the row is untouched", async () => {
    const { run, tabs } = tool();
    await run({
      ...base,
      mode: "upsert",
      key_column: "Student",
      rows: [{ key: "Ana Reyes", set: { Grade: "4" } }],
    });
    const row = tabs.get("roster")!.grid[1];
    expect(row[1]).toBe("4");
    expect(row[2]).toBe("Clay Studio");
  });

  test("an unmatched key becomes an appended row in the same write", async () => {
    const { run, calls, tabs } = tool();
    const response = await run({
      ...base,
      mode: "upsert",
      key_column: "Student",
      rows: [
        { key: "Ana Reyes", set: { Grade: "4" } },
        { key: "Cy Okafor", set: { Grade: "5", Club: "Chess Club" } },
      ],
    });

    expect(calls.valuesBatchUpdate).toHaveLength(1);
    expect(calls.valuesAppend).toHaveLength(0);
    const grid = tabs.get("roster")!.grid;
    expect(grid[3][0]).toBe("Cy Okafor");
    expect((response.structuredContent as { inserted: number }).inserted).toBe(1);
  });

  test("matching ignores case and surrounding space", async () => {
    const { run, tabs } = tool();
    await run({
      ...base,
      mode: "upsert",
      key_column: "Student",
      rows: [{ key: "  ana reyes ", set: { Grade: "4" } }],
    });
    expect(tabs.get("roster")!.grid[1][1]).toBe("4");
  });

  test("without a key column and without a contract it refuses and lists the columns", async () => {
    const { run } = tool();
    const response = await run({
      ...base,
      mode: "upsert",
      rows: [{ key: "Ana Reyes", set: { Grade: "4" } }],
    });
    expect(errorOf(response)?.hint).toContain("Student");
  });

  test("a repeated key updates the first row and warns about the rest", async () => {
    const dupes = structuredClone(ROSTER);
    dupes.tabs[0].values!.push(["Ana Reyes", "3", "Chess Club", "8", "440"]);
    dupes.tabs[0].formulas!.push(["Ana Reyes", "3", "Chess Club", "8", "440"]);
    const { run, tabs } = tool(dupes);
    const response = await run({
      ...base,
      mode: "upsert",
      key_column: "Student",
      rows: [{ key: "Ana Reyes", set: { Grade: "9" } }],
    });
    expect(tabs.get("roster")!.grid[1][1]).toBe("9");
    expect(tabs.get("roster")!.grid[3][1]).toBe("3");
    expect((response.structuredContent as { warnings: string[] }).warnings.join(" ")).toContain(
      "repeats",
    );
  });
});

describe("mode fill", () => {
  test("sends one autoFill with the right fill length", async () => {
    const blank: WriteSpreadsheetSpec = {
      title: "Autumn Clubs",
      tabs: [
        {
          title: "Roster",
          sheetId: 0,
          frozenRowCount: 1,
          values: [
            ["Student", "Sessions", "Fee"],
            ["Ana Reyes", "8", ""],
            ["Bo Tran", "8", ""],
            ["Cy Okafor", "8", ""],
          ],
        },
      ],
    };
    const { run, calls } = tool(blank);
    const response = await run({ ...base, mode: "fill", range: "C2:C4", formula: "=B2*55" });

    expect(isFailure(response)).toBe(false);
    const requests = (calls.batchUpdate[0]["requestBody"] as { requests: Array<Record<string, unknown>> })
      .requests;
    const autoFill = requests.find((r) => "autoFill" in r)!["autoFill"] as {
      sourceAndDestination: { fillLength: number; dimension: string };
    };
    expect(autoFill.sourceAndDestination.fillLength).toBe(2);
    expect(autoFill.sourceAndDestination.dimension).toBe("ROWS");
  });

  test("an open-ended range is refused rather than filling to the bottom of the sheet", async () => {
    const { run } = tool();
    const response = await run({ ...base, mode: "fill", range: "E:E", formula: "=D2*55" });
    expect(errorOf(response)?.message).toContain("bounded on both ends");
  });

  test("a one row range has nothing to fill", async () => {
    const { run } = tool();
    const response = await run({ ...base, mode: "fill", range: "E2", formula: "=D2*55" });
    expect(errorOf(response)?.message).toContain("nothing to fill");
  });

  test("filling over existing formulas is refused without force", async () => {
    const { run } = tool();
    const response = await run({ ...base, mode: "fill", range: "E2:E3" });
    expect(errorOf(response)?.code).toBe("formula_guard");
  });
});

describe("dry_run and check", () => {
  test("dry_run sends no write at all and reports the plan", async () => {
    const { run, calls } = tool();
    const response = await run({ ...base, range: "B2:B3", values: [["4"], ["5"]], dry_run: true });

    expect(calls.valuesBatchUpdate).toHaveLength(0);
    expect(calls.batchUpdate).toHaveLength(0);
    const structured = response.structuredContent as { dry_run: boolean; ranges: unknown[] };
    expect(structured.dry_run).toBe(true);
    expect(structured.ranges).toHaveLength(1);
    expect(response.content[0].text).toContain("Nothing was written");
  });

  test("dry_run still runs the guards", async () => {
    const { run } = tool();
    const response = await run({ ...base, range: "E2", values: [["500"]], dry_run: true });
    expect(errorOf(response)?.code).toBe("formula_guard");
  });

  test("check false skips the read back and says the work is not verified", async () => {
    const { run } = tool();
    const response = await run({ ...base, range: "B2", values: [["4"]], check: false });
    const check = (response.structuredContent as { check: { status: string; note?: string } }).check;
    expect(check.status).toBe("skipped");
    expect(check.note).toContain("sheets_check");
  });

  test("the gate reports an error the sheet already had in the written range", async () => {
    const broken = structuredClone(ROSTER);
    broken.tabs[0].errors = { B2: "REF" };
    const { run } = tool(broken);
    const response = await run({ ...base, range: "B2", values: [["4"]] });
    const check = (response.structuredContent as { check: { status: string } }).check;
    expect(check.status).toBe("errors_found");
    expect(response.content[0].text).toContain("Check: 1 error(s)");
  });
});

describe("how far down the tab a write reads", () => {
  const rowsOf = (range: string) => Number(/(\d+)$/.exec(range)?.[1] ?? 0);

  test("a range write reads only far enough to find the header", async () => {
    const { run, calls } = tool();
    await run({ ...base, range: "B2", values: [["4"]] });
    const scan = (calls.batchGet[0] as { ranges: string[] }).ranges[0];
    expect(rowsOf(scan)).toBeLessThanOrEqual(25);
  });

  test("an append reads the tab, because it has to know where the data ends", async () => {
    const { run, calls } = tool();
    await run({ ...base, mode: "append", values: [["Cy Okafor"]] });
    const scan = (calls.batchGet[0] as { ranges: string[] }).ranges[0];
    expect(rowsOf(scan)).toBeGreaterThan(1000);
  });
});

describe("a pasted URL", () => {
  test("is accepted where the id belongs", async () => {
    const { run } = tool();
    const response = await run({
      ...base,
      spreadsheet_id: `https://docs.google.com/spreadsheets/d/${WRITE_SPREADSHEET_ID}/edit#gid=0`,
      range: "B2",
      values: [["4"]],
    });
    expect(isFailure(response)).toBe(false);
  });
});

describe("the pure helpers", () => {
  test("resolveHeaderRow prefers what was asked for, then the frozen rows", () => {
    expect(resolveHeaderRow(3, 1, [["a", "b"]])).toBe(3);
    expect(resolveHeaderRow(undefined, 2, [["a", "b"]])).toBe(2);
    expect(resolveHeaderRow(undefined, 0, [["Student", "Grade"], ["Ana", "3"]])).toBe(1);
    expect(resolveHeaderRow(undefined, 0, [])).toBeUndefined();
  });

  test("findBlocks stops at the blank row", () => {
    const grid = [["h"], ["a"], ["b"], [""], ["totals"]];
    expect(findBlocks(grid, 2)).toEqual({ lastDataRow: 3, multipleBlocks: true });
  });

  test("findBlocks on one block reports no second one", () => {
    expect(findBlocks([["h"], ["a"], ["b"]], 2)).toEqual({ lastDataRow: 3, multipleBlocks: false });
  });

  test("coalesce turns scattered columns into contiguous runs", () => {
    expect(coalesce([0, 1, 2, 5, 7, 8])).toEqual([[0, 1, 2], [5], [7, 8]]);
    expect(coalesce([])).toEqual([]);
    expect(coalesce([3, 3, 3])).toEqual([[3]]);
  });

  test("resolveColumn takes a header or a letter and refuses anything else", () => {
    const headers = ["Student", "Grade"];
    expect(resolveColumn("Grade", headers)).toMatchObject({ index: 1, letter: "B" });
    expect(resolveColumn("grade", headers).index).toBe(1);
    expect(resolveColumn("C", headers)).toMatchObject({ index: 2, letter: "C" });
    expect(() => resolveColumn("Nickname", headers)).toThrow(/No column named/);
  });
});
