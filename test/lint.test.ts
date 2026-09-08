/**
 * The lint rules, one describe per rule.
 *
 * Two things are worth as much as the positive cases here and get as much room:
 * that a rule stays quiet when it should, and that its `fix` string names a real
 * call. A rule that fires on a legitimate arrangement is worse than no rule,
 * because the first thing anybody does with a noisy lint is stop reading it.
 */

import { describe, expect, test } from "vitest";

import { l01FormulaError, tallyFormulaErrors } from "../src/lib/lint/l01-formula-error.js";
import { l04MergeInData } from "../src/lib/lint/l04-merge-in-data.js";
import { l09FrozenHeader } from "../src/lib/lint/l09-frozen-header.js";
import { l14WriteOutsideColumns } from "../src/lib/lint/l14-write-outside-columns.js";
import { l20KeyColumn } from "../src/lib/lint/l20-key-column.js";
import { l22CheckColumn } from "../src/lib/lint/l22-check-column.js";
import { l23ColleagueText } from "../src/lib/lint/l23-colleague-text.js";
import {
  LINT_RULES,
  LINT_RULE_IDS,
  countBySeverity,
  runRules,
  selectRules,
} from "../src/lib/lint/index.js";
import { dataRegion, headerRowIndex, lintLocation } from "../src/lib/lint/types.js";
import { lintContext, registryJson } from "./helpers/lintFixtures.js";

const ROSTER_ROWS = [
  [
    { value: "Student", bold: true },
    { value: "Teacher", bold: true },
    { value: "Sessions", bold: true },
    { value: "Fee", bold: true },
  ],
  ["Nell Ashgrove", "Bellweather", 16, "=C2*80"],
  ["Iver Tolman", "Bellweather", 16, "=C3*80"],
  ["Perrin Vale", "Scott Ling", 8, "=C4*80"],
];

describe("L01, a cell evaluating to an error", () => {
  test("reports each error cell with its address and its type", () => {
    const ctx = lintContext({
      title: "Roster",
      frozenRows: 1,
      rows: [
        ...ROSTER_ROWS.slice(0, 3),
        ["Perrin Vale", "Scott Ling", 8, { formula: "=C4*Rate", error: "NAME", errorMessage: "Unknown range name: 'Rate'." }],
      ],
    });

    const findings = l01FormulaError.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].location).toBe("Roster!D4");
    expect(findings[0].message).toContain("#NAME?");
    expect(findings[0].message).toContain("Unknown range name");
    expect(findings[0].fix).toContain("sheets_read");
  });

  test("counts formulas and leaves a clean sheet alone", () => {
    const ctx = lintContext({ title: "Roster", frozenRows: 1, rows: ROSTER_ROWS });
    expect(l01FormulaError.run(ctx)).toEqual([]);
    expect(tallyFormulaErrors(ctx).totalFormulas).toBe(3);
  });

  test("LOADING is counted as pending, never as an error", () => {
    const ctx = lintContext({
      title: "Live",
      rows: [["Ticker", "Price"], ["ACME", { formula: "=GOOGLEFINANCE(\"ACME\")", error: "LOADING" }]],
    });
    const tally = tallyFormulaErrors(ctx);
    expect(tally.loading).toBe(1);
    expect(tally.errors).toEqual([]);
    expect(l01FormulaError.run(ctx)).toEqual([]);
  });

  test("a cascade is summarised rather than reported forty times", () => {
    const rows: Array<Array<unknown>> = [["Name", "Value"]];
    for (let i = 0; i < 40; i += 1) rows.push([`Row ${i}`, { formula: "=A1/0", error: "DIVIDE_BY_ZERO" }]);
    const ctx = lintContext({ title: "Wide", rows: rows as never });
    const findings = l01FormulaError.run(ctx);
    expect(findings.length).toBeLessThan(30);
    expect(findings[findings.length - 1].message).toContain("more cell");
  });

  test("the offsets of a partial read are honoured", () => {
    // A read that started at C10 must not report its first cell as A1.
    const ctx = lintContext({
      title: "Sheet1",
      startRow: 9,
      startColumn: 2,
      rows: [[{ formula: "=X1", error: "REF" }]],
    });
    expect(l01FormulaError.run(ctx)[0].location).toBe("Sheet1!C10");
  });
});

describe("L04, a merge inside the data", () => {
  test("flags a merge that covers the header row", () => {
    const ctx = lintContext({
      title: "Roster",
      frozenRows: 1,
      rows: ROSTER_ROWS,
      merges: [{ startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 2 }],
    });
    const findings = l04MergeInData.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].location).toBe("Roster!A1:B1");
    expect(findings[0].message).toContain("header row");
    expect(findings[0].fix).toContain("unmerge");
  });

  test("flags a merge inside a Table by name", () => {
    const ctx = lintContext({
      title: "Roster",
      frozenRows: 1,
      rows: ROSTER_ROWS,
      tables: [
        {
          name: "RosterTable",
          range: { startRowIndex: 0, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 4 },
        },
      ],
      merges: [{ startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 2 }],
    });
    const findings = l04MergeInData.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('the Table "RosterTable"');
  });

  test("a merged title above the header row is left alone", () => {
    // This is the arrangement the fix string recommends, so flagging it would
    // send somebody in a circle.
    const ctx = lintContext({
      title: "Roster",
      frozenRows: 2,
      rows: [
        [{ value: "Spring lessons", bold: true }, "", "", ""],
        [
          { value: "Student", bold: true },
          { value: "Teacher", bold: true },
          { value: "Sessions", bold: true },
          { value: "Fee", bold: true },
        ],
        ["Nell Ashgrove", "Bellweather", 16, "=C3*80"],
      ],
      merges: [{ startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 4 }],
    });
    expect(l04MergeInData.run(ctx)).toEqual([]);
  });

  test("a tab with no merges says nothing", () => {
    const ctx = lintContext({ title: "Roster", frozenRows: 1, rows: ROSTER_ROWS });
    expect(l04MergeInData.run(ctx)).toEqual([]);
  });
});

describe("L09, a header row that is not frozen", () => {
  test("fires on a Table with no frozen rows", () => {
    const ctx = lintContext({
      title: "Roster",
      rows: ROSTER_ROWS,
      tables: [{ range: { startRowIndex: 0, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 4 } }],
    });
    const findings = l09FrozenHeader.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].location).toBe("Roster!A1:D1");
    expect(findings[0].fix).toBe('sheets_style with sheet: "Roster", freeze_rows: 1');
  });

  test("fires on a bold first row with no frozen rows", () => {
    const ctx = lintContext({ title: "Roster", rows: ROSTER_ROWS });
    expect(l09FrozenHeader.run(ctx)).toHaveLength(1);
  });

  test("stays quiet once the header is frozen", () => {
    const ctx = lintContext({ title: "Roster", frozenRows: 1, rows: ROSTER_ROWS });
    expect(l09FrozenHeader.run(ctx)).toEqual([]);
  });

  test("stays quiet on a scratch tab whose header was only inferred", () => {
    const ctx = lintContext({
      title: "Scratch",
      rows: [
        ["Name", "Count"],
        ["Ilse Mordant", 3],
      ],
    });
    expect(l09FrozenHeader.run(ctx)).toEqual([]);
  });
});

describe("L14, a write outside the columns that are ours", () => {
  const registry = registryJson({
    name: "The Background Check Tracker",
    owner: "shared",
    writable_columns: ["A", "B", "C"],
  });

  test("flags a write that reached a column the registry withholds", () => {
    const ctx = lintContext({
      title: "Tracker",
      frozenRows: 1,
      registry,
      rows: [
        ["Vendor", "Instructor", "Email", "Fingerprints"],
        ["Clay & Kiln", "Oren Whitfield", "oren@example.com", "2026-09-01"],
      ],
      writes: [{ range: "'Tracker'!D2:D2", sheet: "Tracker" }],
    });
    const findings = l14WriteOutsideColumns.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].location).toBe("Tracker!D2:D2");
    expect(findings[0].message).toContain('"Fingerprints"');
    expect(findings[0].message).toContain("writable columns");
    expect(findings[0].fix).toContain("Undo it");
  });

  test("says nothing about a write inside the writable columns", () => {
    const ctx = lintContext({
      title: "Tracker",
      frozenRows: 1,
      registry,
      rows: [
        ["Vendor", "Instructor", "Email", "Fingerprints"],
        ["Clay & Kiln", "Oren Whitfield", "oren@example.com", "2026-09-01"],
      ],
      writes: [{ range: "'Tracker'!A2:C2", sheet: "Tracker" }],
    });
    expect(l14WriteOutsideColumns.run(ctx)).toEqual([]);
  });

  test("a value already sitting in a human's column is not a finding", () => {
    // The rule is about what this session did, not about what is there.
    const ctx = lintContext({
      title: "Tracker",
      frozenRows: 1,
      registry,
      rows: [
        ["Vendor", "Instructor", "Email", "Fingerprints"],
        ["Clay & Kiln", "Oren Whitfield", "oren@example.com", "2026-09-01"],
      ],
    });
    expect(l14WriteOutsideColumns.run(ctx)).toEqual([]);
  });

  test("column metadata marking a column human is enough on its own", () => {
    const ctx = lintContext({
      title: "Roster",
      frozenRows: 1,
      rows: [
        ["Student", "Teacher", "Notes"],
        ["Nell Ashgrove", "Bellweather", "Prefers Tuesdays"],
      ],
      columnMetadata: { 2: { name: "notes", header: "Notes", owner: "human" } },
      writes: [{ range: "'Roster'!C2", sheet: "Roster" }],
    });
    const findings = l14WriteOutsideColumns.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("column metadata marks it as a human's");
  });

  test("a write on another tab is not this tab's problem", () => {
    const ctx = lintContext({
      title: "Tracker",
      frozenRows: 1,
      registry,
      rows: [["Vendor", "Instructor", "Email", "Fingerprints"]],
      writes: [{ range: "'Other'!D2", sheet: "Other" }],
    });
    expect(l14WriteOutsideColumns.run(ctx)).toEqual([]);
  });
});

describe("L20, the key column", () => {
  const withKey = {
    title: "Roster",
    frozenRows: 1,
    sheetMetadata: { keyColumn: "Email", headerRow: 1 },
  };

  test("flags a blank key", () => {
    const ctx = lintContext({
      ...withKey,
      rows: [
        ["Student", "Email"],
        ["Nell Ashgrove", "nell@example.com"],
        ["Iver Tolman", ""],
      ],
    });
    const findings = l20KeyColumn.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].location).toBe("Roster!B3");
    expect(findings[0].message).toContain("blank");
    expect(findings[0].fix).toContain("Do not switch to matching on row numbers");
  });

  test("flags a duplicate, ignoring case", () => {
    const ctx = lintContext({
      ...withKey,
      rows: [
        ["Student", "Email"],
        ["Nell Ashgrove", "nell@example.com"],
        ["Nell A.", "NELL@example.com"],
      ],
    });
    const findings = l20KeyColumn.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("B2");
    expect(findings[0].message).toContain("B3");
    expect(findings[0].location).toBe("Roster!B2:B3");
  });

  test("a complete and unique key column says nothing", () => {
    const ctx = lintContext({
      ...withKey,
      rows: [
        ["Student", "Email"],
        ["Nell Ashgrove", "nell@example.com"],
        ["Iver Tolman", "iver@example.com"],
      ],
    });
    expect(l20KeyColumn.run(ctx)).toEqual([]);
  });

  test("no contract means no opinion about which column is the key", () => {
    const ctx = lintContext({
      title: "Roster",
      frozenRows: 1,
      rows: [
        ["Student", "Email"],
        ["Nell Ashgrove", ""],
        ["Iver Tolman", ""],
      ],
    });
    expect(l20KeyColumn.run(ctx)).toEqual([]);
  });

  test("a column whose contract role is key is found without a keyColumn name", () => {
    const ctx = lintContext({
      title: "Roster",
      frozenRows: 1,
      rows: [
        ["Email", "Student"],
        ["", "Nell Ashgrove"],
      ],
      columnMetadata: { 0: { name: "email", header: "Email", role: "key" } },
    });
    expect(l20KeyColumn.run(ctx)).toHaveLength(1);
  });
});

describe("L22, the Check column", () => {
  const checkMetadata = { 3: { name: "check", header: "Check", role: "check" as const } };

  test("quotes what the column says", () => {
    const ctx = lintContext({
      title: "Roster",
      frozenRows: 1,
      rows: [
        ["Student", "Teacher", "Email", "Check"],
        ["Nell Ashgrove", "Bellweather", "nell@example.com", ""],
        ["Iver Tolman", "Bellweather", "", "Missing email"],
      ],
      columnMetadata: checkMetadata,
    });
    const findings = l22CheckColumn.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].message).toContain("Missing email");
    expect(findings[0].message).toContain("Roster!D3");
    expect(findings[0].fix).toContain("Do not clear the column");
  });

  test("a Check column that is blank all the way down says nothing", () => {
    const ctx = lintContext({
      title: "Roster",
      frozenRows: 1,
      rows: [
        ["Student", "Teacher", "Email", "Check"],
        ["Nell Ashgrove", "Bellweather", "nell@example.com", ""],
      ],
      columnMetadata: checkMetadata,
    });
    expect(l22CheckColumn.run(ctx)).toEqual([]);
  });

  test("a Check formula evaluating to blank is not a flag", () => {
    // The FORMULA render shows "=IF(...)" for every row, so reading that alone
    // would report every row as flagged.
    const ctx = lintContext({
      title: "Roster",
      frozenRows: 1,
      rows: [
        ["Student", "Teacher", "Email", "Check"],
        ["Nell Ashgrove", "Bellweather", "nell@example.com", { formula: '=IF(C2="","Missing email","")', value: "" }],
      ],
      columnMetadata: checkMetadata,
    });
    expect(l22CheckColumn.run(ctx)).toEqual([]);
  });

  test("a Check formula that evaluated to text is a flag", () => {
    const ctx = lintContext({
      title: "Roster",
      frozenRows: 1,
      rows: [
        ["Student", "Teacher", "Email", "Check"],
        ["Iver Tolman", "Bellweather", "", { formula: '=IF(C2="","Missing email","")', value: "Missing email" }],
      ],
      columnMetadata: checkMetadata,
    });
    const findings = l22CheckColumn.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("Missing email");
  });

  test("no check role means the rule does not run", () => {
    const ctx = lintContext({
      title: "Roster",
      frozenRows: 1,
      rows: [
        ["Student", "Check"],
        ["Nell Ashgrove", "Missing email"],
      ],
    });
    expect(l22CheckColumn.run(ctx)).toEqual([]);
  });
});

describe("L23, text that does not read as a colleague's", () => {
  const shared = registryJson({ name: "The Private Lessons Schedule", owner: "shared" });

  test("flags a message id in a cell", () => {
    const ctx = lintContext({
      title: "Schedule",
      frozenRows: 1,
      registry: shared,
      rows: [
        ["Student", "Status"],
        ["Nell Ashgrove", "Confirmed per 18f2a1c9b4d0e77a"],
      ],
    });
    const findings = l23ColleagueText.run(ctx);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].location).toBe("Schedule!B2");
    expect(findings[0].message).toContain("machine output");
  });

  test("flags a note and says it was the note", () => {
    const ctx = lintContext({
      title: "Schedule",
      frozenRows: 1,
      registry: shared,
      rows: [
        ["Student", "Status"],
        ["Nell Ashgrove", { value: "Confirmed", note: "Written by the agent on the overnight run." }],
      ],
    });
    const findings = l23ColleagueText.run(ctx);
    expect(findings.some((f) => f.message.includes("The note at"))).toBe(true);
    expect(findings.some((f) => f.fix.includes("note"))).toBe(true);
  });

  test("flags validation help text", () => {
    const ctx = lintContext({
      title: "Schedule",
      frozenRows: 1,
      registry: shared,
      rows: [
        ["Student", "Status"],
        ["Nell Ashgrove", { value: "Confirmed", help: "TODO: check the agent_draft_log row first." }],
      ],
    });
    const findings = l23ColleagueText.run(ctx);
    expect(findings.some((f) => f.message.includes("validation help text"))).toBe(true);
  });

  test("says nothing on a sheet the agent owns", () => {
    const ctx = lintContext({
      title: "Schedule",
      frozenRows: 1,
      registry: registryJson({ owner: "agent" }),
      rows: [
        ["Student", "Status"],
        ["Nell Ashgrove", "TODO: confirm the time"],
      ],
    });
    expect(l23ColleagueText.run(ctx)).toEqual([]);
  });

  test("an allowlisted phrase is not flagged", () => {
    const ctx = lintContext({
      title: "Schedule",
      frozenRows: 1,
      registry: registryJson({ owner: "shared", allowlist: ["agent"] }),
      rows: [
        ["Task", "Owner"],
        ["Ship the agent release", "Ilse Mordant"],
        ["Rewrite the agent log parser", "Ilse Mordant"],
      ],
    });
    expect(l23ColleagueText.run(ctx)).toEqual([]);
  });

  test("ordinary colleague prose is left alone", () => {
    const ctx = lintContext({
      title: "Schedule",
      frozenRows: 1,
      registry: shared,
      rows: [
        ["Student", "Status", "Notes"],
        ["Nell Ashgrove", "Confirmed", "Moved to 3:15 so she can make the bus."],
        ["Iver Tolman", "Waiting on the family", "Emailed Tuesday, no reply yet."],
      ],
    });
    expect(l23ColleagueText.run(ctx)).toEqual([]);
  });
});

describe("shared helpers", () => {
  test("a tab name that needs quoting gets them, and one that does not, does not", () => {
    expect(lintLocation("Roster", "A1:J1")).toBe("Roster!A1:J1");
    expect(lintLocation("2026-27 Academic Year", "A1")).toBe("'2026-27 Academic Year'!A1");
  });

  test("the header row comes from the contract before anything else", () => {
    const ctx = lintContext({
      title: "Roster",
      frozenRows: 1,
      rows: [["Spring"], ["Student", "Teacher"], ["Nell Ashgrove", "Bellweather"]],
      sheetMetadata: { headerRow: 2 },
    });
    expect(headerRowIndex(ctx)).toBe(1);
  });

  test("the data region stops at the last row carrying anything", () => {
    const ctx = lintContext({
      title: "Roster",
      frozenRows: 1,
      rows: [["Student", "Teacher"], ["Nell Ashgrove", "Bellweather"], ["", ""]],
    });
    const region = dataRegion(ctx);
    expect(region.headerRow).toBe(0);
    expect(region.firstDataRow).toBe(1);
    expect(region.lastDataRow).toBe(1);
    expect(region.lastColumn).toBe(1);
  });
});

describe("the rule set", () => {
  test("every rule the catalogue lists is registered, and nothing else is", () => {
    expect(LINT_RULE_IDS).toEqual(["L01", "L04", "L09", "L14", "L20", "L22", "L23"]);
  });

  test("every rule's severity matches the catalogue", () => {
    const expected: Record<string, string> = {
      L01: "error",
      L04: "error",
      L09: "warning",
      L14: "warning",
      L20: "warning",
      L22: "warning",
      L23: "warning",
    };
    for (const rule of LINT_RULES) expect(rule.severity).toBe(expected[rule.id]);
  });

  test("every finding carries a fix that names a tool or an action", () => {
    const ctx = lintContext({
      title: "Roster",
      registry: registryJson({ owner: "shared", writable_columns: ["A"] }),
      rows: [
        [{ value: "Student", bold: true }, { value: "Check", bold: true }],
        ["Nell Ashgrove", { formula: "=X1", error: "REF" }],
      ],
      merges: [{ startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 2 }],
      writes: [{ range: "'Roster'!B2", sheet: "Roster" }],
      columnMetadata: { 1: { name: "check", header: "Check", role: "check" } },
    });
    const { findings } = runRules(ctx);
    expect(findings.length).toBeGreaterThan(3);
    for (const finding of findings) {
      expect(finding.fix.length).toBeGreaterThan(20);
      expect(finding.location.startsWith("Roster")).toBe(true);
    }
  });

  test("rules can be selected, and an unknown id is reported rather than ignored", () => {
    const ctx = lintContext({ title: "Roster", frozenRows: 1, rows: ROSTER_ROWS });
    const result = runRules(ctx, { rules: ["L09", "L99"] });
    expect(result.ran).toEqual(["L09"]);
    expect(result.unknown).toEqual(["L99"]);
  });

  test("selection keeps the catalogue's order rather than the caller's", () => {
    expect(selectRules(["L23", "L01"]).rules.map((r) => r.id)).toEqual(["L01", "L23"]);
  });

  test("severities are counted for the headline", () => {
    const counts = countBySeverity([
      { rule: "L01", severity: "error", location: "A1", message: "", fix: "" },
      { rule: "L09", severity: "warning", location: "A1", message: "", fix: "" },
      { rule: "L23", severity: "warning", location: "A1", message: "", fix: "" },
    ]);
    expect(counts).toEqual({ error: 1, warning: 2, info: 0 });
  });
});
